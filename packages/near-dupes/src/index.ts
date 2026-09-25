// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/near-dupes` — pure algorithm + filter primitives for the
 * near-duplicate detection pipeline. All exports are I/O-free and
 * reusable by both the study tooling (study runner, side-DB report)
 * and the production glue under `packages/gateway/src/near-dupes/`.
 *
 * Organised in three layers:
 *   - `algo/*`    — MinHash, weighted MinHash (Ioffe ICWS), LSH,
 *                   Jaccard, shingles, DfTable, sketchers.
 *   - `filters/edge-filters.ts` — `isExactDupe`, `isSameThread`,
 *                                 `shouldSuppress`.
 *   - `filters/edge-gate.ts`    — source-family thresholds +
 *                                 automated-sender allowlist
 *                                 (`gatePair`, `isAutomatedSender`,
 *                                 `sourceFamily`).
 */

export * from "./algo/index.js";
export * from "./filters/edge-filters.js";
export * from "./filters/edge-gate.js";
