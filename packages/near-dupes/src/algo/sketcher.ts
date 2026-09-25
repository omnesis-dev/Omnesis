// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { minhash, type MinhashParams } from "./minhash.js";
import {
  weightedMinhash,
  type WeightedMinhashParams,
  type WeightedShingle,
} from "./weighted-minhash.js";
import { lshBands, type LshParams } from "./lsh.js";
import { jaccard, weightedJaccard } from "./jaccard.js";
import { type DfTable, idfWeight, type IdfWeightOpts } from "./idf.js";

/**
 * Minimal duck-typed interface for the DF lookup. The production
 * gateway populates this from `near_dup_df` SQLite rows; the study
 * tooling passes a full `DfTable`. Both satisfy the interface so the
 * sketcher and `computeExclusivity` work without a concrete coupling.
 */
export interface DfLike {
  readonly totalDocs: number;
  df(shingle: string): number;
}

/**
 * Common surface over vanilla and IDF-weighted MinHash. The runner
 * (and the future in-gateway writer hook) is unaware of which mode is
 * active — it just calls `sign`, `bands`, and `verify`.
 *
 * Signatures returned by `sign` are intentionally untyped at the
 * boundary (`Uint32Array`): for the uniform sketcher they are N
 * uint32s; for the IDF sketcher they are 2N (winnerHash, t pairs).
 * `bands` knows the slot width from its `LshParams.slotsPerRow`.
 */
/**
 * Pair-level statistics used by the exclusivity gate. `pairUniqueDfK`
 * counts shingles in A∩B whose corpus document-frequency is ≤ K, the
 * signal that the shared content is unique to this pair (or its tight
 * cluster) rather than template content shared with the broader corpus.
 */
export interface ExclusivityStats {
  intersectionSize: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
}

export interface Sketcher {
  readonly signatureUint32Length: number;
  sign(shingles: ReadonlySet<string>): Uint32Array;
  bands(sig: Uint32Array): Uint32Array;
  verify(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
  /**
   * Optional pair-level exclusivity scoring. Returns null when the
   * sketcher has no DF data to work from (vanilla MinHash mode).
   */
  exclusivity?(a: ReadonlySet<string>, b: ReadonlySet<string>): ExclusivityStats;
}

export class UniformSketcher implements Sketcher {
  readonly signatureUint32Length: number;
  constructor(
    private readonly params: MinhashParams,
    private readonly lshParams: LshParams,
  ) {
    this.signatureUint32Length = params.numHashes;
  }
  sign(shingles: ReadonlySet<string>): Uint32Array {
    return minhash(shingles, this.params);
  }
  bands(sig: Uint32Array): Uint32Array {
    return lshBands(sig, this.lshParams);
  }
  verify(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    return jaccard(a, b);
  }
}

export class IdfSketcher implements Sketcher {
  readonly signatureUint32Length: number;
  constructor(
    private readonly params: WeightedMinhashParams,
    private readonly lshParams: LshParams,
    private readonly df: DfLike,
    private readonly weightOpts: IdfWeightOpts = {},
  ) {
    this.signatureUint32Length = 2 * params.numHashes;
  }
  sign(shingles: ReadonlySet<string>): Uint32Array {
    return weightedMinhash(this.weighShingles(shingles), this.params);
  }
  bands(sig: Uint32Array): Uint32Array {
    return lshBands(sig, this.lshParams);
  }
  verify(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    return weightedJaccard((s) => this.weightOf(s), a, b);
  }

  exclusivity(a: ReadonlySet<string>, b: ReadonlySet<string>): ExclusivityStats {
    return computeExclusivity(this.df, a, b);
  }

  private weightOf(s: string): number {
    return idfWeight(this.df.df(s), this.df.totalDocs, this.weightOpts);
  }

  private *weighShingles(shingles: ReadonlySet<string>): Iterable<WeightedShingle> {
    for (const s of shingles) {
      const w = this.weightOf(s);
      if (w > 0) yield { shingle: s, weight: w };
    }
  }
}

/**
 * Stand-alone exclusivity computation — exported so callers can patch
 * exclusivity into pairs that were recorded under a vanilla-MinHash
 * run (which has no DfTable of its own).
 */
export function computeExclusivity(
  df: DfLike,
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ExclusivityStats {
  let intersectionSize = 0;
  let pairUniqueDf2 = 0;
  let pairUniqueDf5 = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) {
    if (!large.has(s)) continue;
    intersectionSize++;
    const d = df.df(s);
    if (d <= 2) pairUniqueDf2++;
    if (d <= 5) pairUniqueDf5++;
  }
  return { intersectionSize, pairUniqueDf2, pairUniqueDf5 };
}
