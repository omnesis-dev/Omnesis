// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { InferenceHealth } from "../inference/model-health.js";
import { IndexerWorkerProxy, type IndexerWorkerOptions } from "./indexer-worker-proxy.js";
import type { EventEmitter } from "node:events";
import type { MainToIndexer } from "./protocol.js";

const workers: EventEmitter[] = [];
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(message: MainToIndexer) {
        if (message.type === "init") queueMicrotask(() => this.emit("message", { type: "ready" }));
        if (message.type === "shutdown") queueMicrotask(() => this.emit("exit", 0));
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

describe("indexer worker model health", () => {
  test("a canceled embedding preserves warnings while a successful embedding clears them", async () => {
    const health = new InferenceHealth(() => ({
      identity: "one",
      fingerprint: "one",
      assignment: "example/embedder",
    }));
    const options = {
      modelPath: "unused",
      modelName: "example-embedder",
      embedDim: 1,
      gatewayDbPath: "unused",
      indexDbPath: "unused",
      usearchIndexPath: "unused",
      cutoffs: { default: null, perSource: {} },
      indexIntervalMs: 1000,
      indexBacklogIntervalMs: 1000,
      dbWriteBatchSize: 1,
      reconcileIntervalMs: 1000,
      reindexMissingIntervalMs: 1000,
      embedConcurrency: 1,
      indexerPageSize: 1,
      indexerBetweenPageSleepMs: 0,
      reindexMissingAtBoot: false,
      chunkerChunkSize: 1,
      chunkerOverlap: 0,
      embedderContextSize: 1,
      embedderTimeoutMs: 1000,
      embedderMaxInputChars: 1000,
      minFreeDiskMb: 0,
      embedderEncoding: { kind: "none" },
      beginModelCall: health.callFactory("embedder"),
    } satisfies IndexerWorkerOptions;
    const proxy = new IndexerWorkerProxy(options);
    try {
      await proxy.whenReady();
      const worker = workers.at(-1)!;
      for (let id = 1; id <= 3; id++) {
        worker.emit("message", { type: "embeddingStarted", id });
        worker.emit("message", {
          type: "embeddingSettled",
          id,
          failure: { category: "quota", message: "Quota exceeded" },
        });
      }
      expect(health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
      worker.emit("message", { type: "embeddingStarted", id: 4 });
      worker.emit("message", { type: "embeddingSettled", id: 4, canceled: true });
      expect(health.snapshot().warnings[0]?.consecutiveFailures).toBe(3);
      worker.emit("message", { type: "embeddingStarted", id: 5 });
      worker.emit("message", { type: "embeddingSettled", id: 5 });
      expect(health.snapshot().warnings).toEqual([]);
    } finally {
      await proxy.dispose();
    }
  });
});
