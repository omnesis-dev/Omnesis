// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parentPort, workerData } from "node:worker_threads";

import { ShingleDfAccumulator } from "../near-dupes/NearDupDfService.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";
import { MAX_DF_STAGING_PAIRS_PER_MESSAGE } from "./near-dup-df-staging-protocol.js";
import type {
  MainToNearDupDfStaging,
  NearDupDfStagingToMain,
  NearDupDfStagingWorkerData,
} from "./near-dup-df-staging-protocol.js";

if (!parentPort) throw new Error("near-dup-df-staging-worker must run in a worker thread");

const init = workerData as NearDupDfStagingWorkerData;
let accumulator: ShingleDfAccumulator | null = null;
let totalDocs = 0;

function post(message: NearDupDfStagingToMain): void {
  parentPort!.postMessage(message);
}

function closeAccumulator(): void {
  if (!accumulator) return;
  accumulator.close({ deleteFile: false });
  accumulator = null;
}

try {
  deprioritizeBackgroundWorker(init.backgroundWorkerNice, "near-dup DF staging", (message) =>
    post({ type: "log", level: "warn", message }),
  );
  accumulator = new ShingleDfAccumulator(
    init.stagingPath,
    init.stagingKeyHex ? Buffer.from(init.stagingKeyHex, "hex") : null,
  );
  post({ type: "ready" });
} catch (error) {
  post({ type: "initError", error: error instanceof Error ? error.message : String(error) });
}

parentPort.on("message", (message: MainToNearDupDfStaging) => {
  if (message.type === "shutdown") {
    try {
      closeAccumulator();
    } finally {
      post({ type: "shutdownComplete" });
    }
    return;
  }

  try {
    if (!accumulator) throw new Error("near-dup DF staging accumulator is closed");
    if (message.type === "add") {
      if (message.result.shingleCounts.length > MAX_DF_STAGING_PAIRS_PER_MESSAGE) {
        throw new Error(
          `DF staging message exceeds ${MAX_DF_STAGING_PAIRS_PER_MESSAGE} shingle pairs`,
        );
      }
      totalDocs += message.result.docsProcessed;
      accumulator.add(message.result.shingleCounts);
      post({ type: "addResult", id: message.id });
      return;
    }

    const uniqueShingles = accumulator.countAtLeast(message.minDf);
    accumulator.checkpoint();
    closeAccumulator();
    post({ type: "finishResult", id: message.id, totalDocs, uniqueShingles });
  } catch (error) {
    post({
      type: "operationError",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
