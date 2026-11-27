// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scoring a grouping against the reference.
 *
 * Each voice window gets the reference speaker who talks most inside it
 * (none when nobody does: a window on non-speech). The attribution error is
 * the share of window time whose hypothesis speaker is not mapped to that
 * reference speaker under the best one-to-one mapping (Hungarian, maximising
 * matched time); a hypothesis speaker left without a partner is wrong for all
 * its time. It is the confusion term of the diarization error rate, measured
 * on the windows the pipeline found.
 */

import type { Turn } from "./dataset.js";

export interface WindowReference {
  /** Reference speaker with the most talk inside the window, or null. */
  speaker: string | null;
  /** Window time with at least two reference speakers talking. */
  overlapMs: number;
  /** Window time with any reference speaker talking. */
  speechMs: number;
}

export function referenceForWindows(
  windows: readonly { startMs: number; endMs: number }[],
  turns: readonly Turn[],
): WindowReference[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const maxLen = Math.max(0, ...sorted.map((t) => t.endMs - t.startMs));
  return windows.map((w) => {
    const per = new Map<string, number>();
    const edges: { at: number; d: number }[] = [];
    // Turns starting after the window ends cannot overlap; those starting more
    // than the longest turn before it cannot either.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.startMs < w.startMs - maxLen) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && sorted[i]!.startMs < w.endMs; i += 1) {
      const t = sorted[i]!;
      const a = Math.max(t.startMs, w.startMs);
      const b = Math.min(t.endMs, w.endMs);
      if (b <= a) continue;
      per.set(t.speaker, (per.get(t.speaker) ?? 0) + (b - a));
      edges.push({ at: a, d: 1 }, { at: b, d: -1 });
    }
    edges.sort((x, y) => x.at - y.at || x.d - y.d);
    let active = 0;
    let prev = w.startMs;
    let overlapMs = 0;
    let speechMs = 0;
    for (const e of edges) {
      if (active >= 1) speechMs += e.at - prev;
      if (active >= 2) overlapMs += e.at - prev;
      active += e.d;
      prev = e.at;
    }
    let speaker: string | null = null;
    let most = 0;
    for (const [s, t] of per) {
      if (t > most) {
        most = t;
        speaker = s;
      }
    }
    return { speaker, overlapMs, speechMs };
  });
}

/** Assignment maximising the summed weight; `result[row] = column or -1`. */
export function maxWeightMatching(weights: readonly (readonly number[])[]): number[] {
  const rows = weights.length;
  const cols = rows === 0 ? 0 : Math.max(...weights.map((r) => r.length));
  const n = Math.max(rows, cols);
  if (n === 0) return [];
  let max = 0;
  for (const r of weights) for (const x of r) max = Math.max(max, x);
  // Minimise cost = max − weight on a padded square matrix (Kuhn–Munkres, potentials).
  const cost = (i: number, j: number): number => max - (weights[i]?.[j] ?? 0);
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j += 1) {
    const i = p[j]! - 1;
    if (i < rows && j - 1 < cols) result[i] = j - 1;
  }
  return result;
}

export interface Attribution {
  /** Share of scored window time attributed to the wrong reference speaker. */
  error: number;
  /** Scored window time (windows with a reference speaker), ms. */
  scoredMs: number;
  /** Hypothesis label → the reference speaker it is mapped to, or null. */
  mapping: Map<number, string | null>;
}

export function attribution(
  labels: readonly number[],
  durationsMs: readonly number[],
  refs: readonly WindowReference[],
  include?: readonly boolean[],
): Attribution {
  const hyp = [...new Set(labels)];
  const ref = [...new Set(refs.flatMap((r) => (r.speaker ? [r.speaker] : [])))];
  const hi = new Map(hyp.map((h, i) => [h, i]));
  const ri = new Map(ref.map((r, i) => [r, i]));
  const w = hyp.map(() => new Array<number>(ref.length).fill(0));
  let scoredMs = 0;
  labels.forEach((l, i) => {
    const r = refs[i]!.speaker;
    if (!r || (include && !include[i])) return;
    w[hi.get(l)!]![ri.get(r)!]! += durationsMs[i]!;
    scoredMs += durationsMs[i]!;
  });
  const match = maxWeightMatching(w);
  let correct = 0;
  const mapping = new Map<number, string | null>();
  match.forEach((c, h) => {
    mapping.set(hyp[h]!, c >= 0 ? ref[c]! : null);
    if (c >= 0) correct += w[h]![c]!;
  });
  return { error: scoredMs > 0 ? 1 - correct / scoredMs : 0, scoredMs, mapping };
}
