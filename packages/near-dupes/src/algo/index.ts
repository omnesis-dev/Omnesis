// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export { murmur3_32, murmur3_32_str } from "./hash.js";
export { normalizeText, tokenize, shingles } from "./shingle.js";
export {
  createMinhashParams,
  minhash,
  packSignature,
  unpackSignature,
  type MinhashParams,
} from "./minhash.js";
export {
  createWeightedMinhashParams,
  weightedMinhash,
  weightedSignatureSimilarity,
  packWeightedSignature,
  unpackWeightedSignature,
  type WeightedMinhashParams,
  type WeightedShingle,
} from "./weighted-minhash.js";
export { DfTable, idfWeight, weighShingles } from "./idf.js";
export { lshBands, validateLshParams, type LshParams } from "./lsh.js";
export { jaccard, weightedJaccard, signatureSimilarity } from "./jaccard.js";
export { mix32, mulberry32, u32ToUnit } from "./prng.js";
export {
  type Sketcher,
  type DfLike,
  type ExclusivityStats,
  UniformSketcher,
  IdfSketcher,
  computeExclusivity,
} from "./sketcher.js";

import { createMinhashParams } from "./minhash.js";
import { createWeightedMinhashParams } from "./weighted-minhash.js";
import { validateLshParams } from "./lsh.js";

export type WeightingMode = "uniform" | "idf";

export interface NearDupeConfig {
  readonly algoVersion: string;
  readonly shingleSize: number;
  readonly numHashes: number;
  readonly bands: number;
  readonly rows: number;
  readonly hashSeed: number;
  readonly stripQuotes: boolean;
  readonly weighting: WeightingMode;
  /** IDF singleton-weight cap; only used when weighting=idf. */
  readonly maxIdfWeight?: number;
}

export const DEFAULT_CONFIG: NearDupeConfig = Object.freeze({
  algoVersion: "mh128-k5-b16-r8-v1",
  shingleSize: 5,
  numHashes: 128,
  bands: 16,
  rows: 8,
  hashSeed: 0xc0ffee,
  stripQuotes: true,
  weighting: "uniform" as const,
});

export const IDF_CONFIG: NearDupeConfig = Object.freeze({
  algoVersion: "ciws128-k5-b16-r8-idf-v1",
  shingleSize: 5,
  numHashes: 128,
  bands: 16,
  rows: 8,
  hashSeed: 0xc0ffee,
  stripQuotes: true,
  weighting: "idf" as const,
  maxIdfWeight: 8.0,
});

export const IDF_EXCL_CONFIG: NearDupeConfig = Object.freeze({
  algoVersion: "ciws128-k5-b16-r8-idf-excl-v2",
  shingleSize: 5,
  numHashes: 128,
  bands: 16,
  rows: 8,
  hashSeed: 0xc0ffee,
  stripQuotes: true,
  weighting: "idf" as const,
  maxIdfWeight: 8.0,
});

export function compileConfig(cfg: NearDupeConfig) {
  const slotsPerRow = cfg.weighting === "idf" ? 2 : 1;
  validateLshParams(cfg.numHashes * slotsPerRow, {
    bands: cfg.bands,
    rows: cfg.rows,
    slotsPerRow,
  });
  return {
    cfg,
    minhashParams: createMinhashParams(cfg.numHashes, cfg.hashSeed),
    weightedMinhashParams: createWeightedMinhashParams(cfg.numHashes, cfg.hashSeed),
    lshParams: { bands: cfg.bands, rows: cfg.rows, slotsPerRow },
  };
}
