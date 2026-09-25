// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DfChunkResult } from "../near-dupes/NearDupDfCpu.js";

/** Bounds synchronous structured-clone work on the gateway thread. */
export const MAX_DF_STAGING_PAIRS_PER_MESSAGE = 10_000;

export interface NearDupDfStagingWorkerData {
  stagingPath: string;
  stagingKeyHex?: string;
  backgroundWorkerNice: number;
}

export type MainToNearDupDfStaging =
  | { type: "add"; id: number; result: DfChunkResult }
  | { type: "finish"; id: number; minDf: number }
  | { type: "shutdown" };

export type NearDupDfStagingToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "addResult"; id: number }
  | { type: "finishResult"; id: number; totalDocs: number; uniqueShingles: number }
  | { type: "operationError"; id: number; error: string }
  | { type: "log"; level: "warn"; message: string }
  | { type: "shutdownComplete" };
