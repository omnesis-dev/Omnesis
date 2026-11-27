// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Spectral clustering with the speaker count from the normalised maximum
 * eigengap (NME-SC; Park et al., "Auto-tuning spectral clustering for speaker
 * diarization using normalized maximum eigengap", 2019).
 *
 * The cosine affinity is binarised to each row's `p` nearest windows and
 * symmetrised; `p` is chosen to minimise (p / n) / (max eigengap / λmax) of
 * the graph Laplacian, the count is the position of that eigengap, and the
 * windows are k-means-clustered on the Laplacian's first eigenvectors.
 */

import { dot } from "./vectors.js";

/** Eigenvalues (ascending) and eigenvectors (`vectors[i][j]`: entry i of vector j) of a symmetric matrix. */
export function symmetricEigen(
  a: readonly Float64Array[],
  wantVectors = true,
): { values: Float64Array; vectors: Float64Array[] } {
  const n = a.length;
  const V = a.map((r) => Float64Array.from(r));
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  if (n === 0) return { values: d, vectors: V };
  // Householder reduction to tridiagonal form (EISPACK tred2, via JAMA).
  for (let j = 0; j < n; j += 1) d[j] = V[n - 1]![j]!;
  for (let i = n - 1; i > 0; i -= 1) {
    let scale = 0;
    let h = 0;
    for (let k = 0; k < i; k += 1) scale += Math.abs(d[k]!);
    if (scale === 0) {
      e[i] = d[i - 1]!;
      for (let j = 0; j < i; j += 1) {
        d[j] = V[i - 1]![j]!;
        V[i]![j] = 0;
        V[j]![i] = 0;
      }
    } else {
      for (let k = 0; k < i; k += 1) {
        d[k]! /= scale;
        h += d[k]! * d[k]!;
      }
      let f = d[i - 1]!;
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j += 1) e[j] = 0;
      for (let j = 0; j < i; j += 1) {
        f = d[j]!;
        V[j]![i] = f;
        g = e[j]! + V[j]![j]! * f;
        for (let k = j + 1; k <= i - 1; k += 1) {
          g += V[k]![j]! * d[k]!;
          e[k]! += V[k]![j]! * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j += 1) {
        e[j]! /= h;
        f += e[j]! * d[j]!;
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j += 1) e[j]! -= hh * d[j]!;
      for (let j = 0; j < i; j += 1) {
        f = d[j]!;
        g = e[j]!;
        for (let k = j; k <= i - 1; k += 1) V[k]![j]! -= f * e[k]! + g * d[k]!;
        d[j] = V[i - 1]![j]!;
        V[i]![j] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1 && wantVectors; i += 1) {
    V[n - 1]![i] = V[i]![i]!;
    V[i]![i] = 1;
    const h = d[i + 1]!;
    if (h !== 0) {
      for (let k = 0; k <= i; k += 1) d[k] = V[k]![i + 1]! / h;
      for (let j = 0; j <= i; j += 1) {
        let g = 0;
        for (let k = 0; k <= i; k += 1) g += V[k]![i + 1]! * V[k]![j]!;
        for (let k = 0; k <= i; k += 1) V[k]![j]! -= g * d[k]!;
      }
    }
    for (let k = 0; k <= i; k += 1) V[k]![i + 1] = 0;
  }
  if (wantVectors) {
    for (let j = 0; j < n; j += 1) {
      d[j] = V[n - 1]![j]!;
      V[n - 1]![j] = 0;
    }
    V[n - 1]![n - 1] = 1;
  } else {
    // Without the accumulation the tridiagonal's diagonal is still on V's.
    for (let j = 0; j < n; j += 1) d[j] = V[j]![j]!;
  }
  e[0] = 0;
  // Implicit QL on the tridiagonal matrix (EISPACK tql2).
  for (let i = 1; i < n; i += 1) e[i - 1] = e[i]!;
  e[n - 1] = 0;
  let f = 0;
  let tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l += 1) {
    tst1 = Math.max(tst1, Math.abs(d[l]!) + Math.abs(e[l]!));
    let m = l;
    while (m < n) {
      if (Math.abs(e[m]!) <= eps * tst1) break;
      m += 1;
    }
    if (m > l) {
      do {
        let g = d[l]!;
        let p = (d[l + 1]! - g) / (2 * e[l]!);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l]! / (p + r);
        d[l + 1] = e[l]! * (p + r);
        const dl1 = d[l + 1]!;
        let h = g - d[l]!;
        for (let i = l + 2; i < n; i += 1) d[i]! -= h;
        f += h;
        p = d[m]!;
        let c = 1;
        let c2 = c;
        let c3 = c;
        const el1 = e[l + 1]!;
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i -= 1) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i]!;
          h = c * p;
          r = Math.hypot(p, e[i]!);
          e[i + 1] = s * r;
          s = e[i]! / r;
          c = p / r;
          p = c * d[i]! - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]!);
          for (let k = 0; wantVectors && k < n; k += 1) {
            const row = V[k]!;
            h = row[i + 1]!;
            row[i + 1] = s * row[i]! + c * h;
            row[i] = c * row[i]! - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]!) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]!) > eps * tst1);
    }
    d[l] = d[l]! + f;
    e[l] = 0;
  }
  const order = Array.from(d.keys()).sort((x, y) => d[x]! - d[y]!);
  return {
    values: Float64Array.from(order, (i) => d[i]!),
    vectors: V.map((row) => Float64Array.from(order, (i) => row[i]!)),
  };
}

function laplacian(sim: readonly Float64Array[], p: number): Float64Array[] {
  const n = sim.length;
  const A = sim.map(() => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    const order = Array.from(sim[i]!.keys()).sort((x, y) => sim[i]![y]! - sim[i]![x]!);
    for (let k = 0; k < p && k < n; k += 1) A[i]![order[k]!] = 1;
  }
  const L = sim.map(() => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    let deg = 0;
    for (let j = 0; j < n; j += 1) {
      const w = 0.5 * (A[i]![j]! + A[j]![i]!);
      if (i !== j) {
        L[i]![j] = -w;
        deg += w;
      }
    }
    L[i]![i] = deg;
  }
  return L;
}

/** Index of the largest gap among the first `maxK` eigenvalues, and that gap / λmax. */
function eigengap(values: Float64Array, maxK: number): { k: number; g: number } {
  let k = 1;
  let gap = -Infinity;
  for (let i = 0; i < Math.min(maxK, values.length - 1); i += 1) {
    const x = values[i + 1]! - values[i]!;
    if (x > gap) {
      gap = x;
      k = i + 1;
    }
  }
  const top = values[values.length - 1]! || 1;
  return { k, g: gap / top };
}

/** A deterministic PRNG so runs repeat. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function kmeans(points: readonly Float64Array[], k: number, restarts = 8): number[] {
  const n = points.length;
  if (k <= 1 || n <= k) return points.map((_, i) => (k <= 1 ? 0 : i));
  const dim = points[0]!.length;
  const dist = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let j = 0; j < dim; j += 1) s += (a[j]! - b[j]!) ** 2;
    return s;
  };
  const rand = mulberry32(12345);
  let best: number[] = [];
  let bestInertia = Infinity;
  for (let r = 0; r < restarts; r += 1) {
    // k-means++ seeding.
    const centers: Float64Array[] = [Float64Array.from(points[Math.floor(rand() * n)]!)];
    while (centers.length < k) {
      const d2 = points.map((p) => Math.min(...centers.map((c) => dist(p, c))));
      const total = d2.reduce((a, b) => a + b, 0);
      let x = rand() * total;
      let pick = 0;
      for (; pick < n - 1; pick += 1) {
        x -= d2[pick]!;
        if (x <= 0) break;
      }
      centers.push(Float64Array.from(points[pick]!));
    }
    let assign = new Array<number>(n).fill(0);
    for (let iter = 0; iter < 100; iter += 1) {
      const next = points.map((p) => {
        let b = 0;
        for (let c = 1; c < k; c += 1) if (dist(p, centers[c]!) < dist(p, centers[b]!)) b = c;
        return b;
      });
      const changed = next.some((x, i) => x !== assign[i]);
      assign = next;
      for (let c = 0; c < k; c += 1) {
        const m = new Float64Array(dim);
        let cnt = 0;
        points.forEach((p, i) => {
          if (assign[i] !== c) return;
          cnt += 1;
          for (let j = 0; j < dim; j += 1) m[j]! += p[j]!;
        });
        if (cnt > 0) centers[c] = m.map((x) => x / cnt);
      }
      if (!changed && iter > 0) break;
    }
    const inertia = points.reduce((s, p, i) => s + dist(p, centers[assign[i]!]!), 0);
    if (inertia < bestInertia) {
      bestInertia = inertia;
      best = assign;
    }
  }
  return best;
}

/** Group unit vectors by NME-SC; at most `maxSpeakers` groups. */
export function spectralGroups(unit: readonly Float32Array[], maxSpeakers: number): number[] {
  const n = unit.length;
  if (n < 3) return unit.map(() => 0);
  const sim = unit.map((a) => Float64Array.from(unit, (b) => dot(a, b)));
  const pMax = Math.max(2, Math.floor(n * 0.25));
  const pMin = Math.max(2, Math.floor(n * 0.02));
  const steps = 12;
  let chosen: { ratio: number; k: number; p: number } | null = null;
  const tried = new Set<number>();
  for (let s = 0; s <= steps; s += 1) {
    const p = Math.round(pMin + ((pMax - pMin) * s) / steps);
    if (tried.has(p)) continue;
    tried.add(p);
    // Eigenvalues alone choose p; the eigenvectors are computed once, for the chosen p.
    const { values } = symmetricEigen(laplacian(sim, p), false);
    const { k, g } = eigengap(values, maxSpeakers);
    const ratio = p / n / Math.max(g, 1e-12);
    if (!chosen || ratio < chosen.ratio) chosen = { ratio, k, p };
  }
  const { k, p } = chosen!;
  const eig = symmetricEigen(laplacian(sim, p));
  const points = eig.vectors.map((row) => {
    const v = row.slice(0, k);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
  return kmeans(points, k);
}
