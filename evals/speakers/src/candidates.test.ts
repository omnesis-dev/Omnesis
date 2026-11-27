// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { groupVoices } from "@omnesis/gateway/src/recordings/voices/voices.js";

import {
  c1,
  c2,
  c5,
  clusterReliable,
  matchSelf,
  meanVoice,
  pinOwner,
  productionFloor,
  Session,
} from "./candidates.js";
import { symmetricEigen } from "./spectral.js";

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}

/** Windows of `speakers` voices, each a noisy copy of a random base vector. */
function synthetic(speakers: number, perSpeaker: number, noise: number, seed = 1) {
  const r = rng(seed);
  const dim = 32;
  const bases = Array.from({ length: speakers }, () =>
    Float32Array.from({ length: dim }, () => r() - 0.5),
  );
  const vectors: Float32Array[] = [];
  const truth: number[] = [];
  const durations: number[] = [];
  for (let k = 0; k < perSpeaker; k += 1)
    for (let s = 0; s < speakers; s += 1) {
      vectors.push(bases[s]!.map((x) => x + noise * (r() - 0.5)));
      truth.push(s);
      durations.push(1_000 + Math.floor(r() * 7_000));
    }
  return { vectors, truth, durations, bases };
}

describe("the eval's clustering copy", () => {
  test("equals production groupVoices for every threshold", () => {
    const { vectors, durations } = synthetic(4, 30, 1.4, 7);
    const s = new Session(vectors, durations);
    for (const t of [0.2, 0.3, 0.4, 0.5, 0.6]) {
      expect(clusterReliable(s, t, 0, productionFloor)).toEqual(groupVoices(vectors, t, durations));
    }
  });
});

describe("candidates", () => {
  test("find well separated speakers", () => {
    const { vectors, durations, truth } = synthetic(3, 20, 0.3, 3);
    const s = new Session(vectors, durations);
    for (const c of [
      c1(0.4, 0.05),
      c2(0.4, 2_000),
      c5({ threshold: 0.3, anchorMs: 30_000, absorbSimilarity: 0.4, participantMs: 10_000 }),
    ]) {
      expect(c.group(s)).toEqual(truth);
    }
  });
});

describe("owner profile", () => {
  test("matchSelf names the speaker whose mean is the profile, and nobody below the threshold", () => {
    const { vectors, durations, truth, bases } = synthetic(2, 10, 0.2, 5);
    const profile = meanVoice([bases[1]!]);
    expect(matchSelf(vectors, truth, profile, 0.5)?.label).toBe(1);
    expect(matchSelf(vectors, truth, profile, 1.01)).toBeNull();
    const labels = pinOwner(new Session(vectors, durations), profile, 0.5, 0.05, (s) =>
      c1(0.4, 0.05).group(s),
    );
    expect(new Set(labels).size).toBe(2);
  });
});

describe("symmetricEigen", () => {
  test("solves A v = λ v", () => {
    const r = rng(11);
    const n = 12;
    const a = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i += 1) for (let j = 0; j <= i; j += 1) a[i]![j] = a[j]![i] = r() - 0.5;
    const { values, vectors } = symmetricEigen(a);
    const alone = symmetricEigen(a, false).values;
    values.forEach((v, k) => expect(alone[k]!).toBeCloseTo(v, 9));
    for (let k = 0; k < n; k += 1) {
      if (k > 0) expect(values[k]!).toBeGreaterThanOrEqual(values[k - 1]!);
      for (let i = 0; i < n; i += 1) {
        let av = 0;
        for (let j = 0; j < n; j += 1) av += a[i]![j]! * vectors[j]![k]!;
        expect(av).toBeCloseTo(values[k]! * vectors[i]![k]!, 9);
      }
    }
  });
});
