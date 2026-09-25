// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import { resolveWorkerEntry } from "@omnesis/core";
import { createDatabase, deleteAllBySource, upsertDocuments } from "../db.js";
import { NO_ENCODING } from "../indexer/embedder-prefixes.js";
import {
  createIndexDatabase,
  deleteChunksByDocument,
  enqueueSourceIndexPurge,
  getIndexedDocumentCount,
  getIndexEmbedModel,
  listPendingSourceIndexPurges,
  scrubPendingSourceIndexPurges,
  getUsearchSavedSeq,
  getVectorWriteSeq,
  openIndexDb,
  upsertChunks,
} from "../indexer/db.js";
import { UsearchReadHandle } from "../indexer/usearch-index.js";
import { IndexerWorkerProxy, type IndexerWorkerOptions } from "./indexer-worker-proxy.js";
import type { DocumentInput } from "@omnesis/types";
import type { IndexerInit, IndexerToMain } from "./protocol.js";

const EMBED_DIM = 8;
const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type FakeEmbedderHold = {
  started: Promise<void>;
  release(): void;
};

type FakeEmbedderServer = {
  server: Server;
  url: string;
  holds: FakeEmbedderHold[];
};

async function startFakeEmbedder(holdTexts: string[] = []): Promise<FakeEmbedderServer> {
  const holdControllers = holdTexts.map((text) => {
    let markStarted: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { text, started, released, markStarted, release, used: false };
  });

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404).end();
      return;
    }

    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const hold = holdControllers.find(
      (candidate) => !candidate.used && inputs.some((input) => input.includes(candidate.text)),
    );
    if (hold) {
      hold.used = true;
      hold.markStarted();
      await hold.released;
    }
    const vectors = inputs.map((_, index) => {
      const embedding = Array<number>(EMBED_DIM).fill(0);
      embedding[index % EMBED_DIM] = 1;
      return { index, embedding };
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: vectors, model: "test-boot-embedder" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    holds: holdControllers.map(({ started, release }) => ({ started, release })),
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function makeDocument(
  externalId: string,
  content: string,
  sourceId = "synthetic:maya@example.com",
): DocumentInput {
  return {
    providerId: "synthetic",
    sourceId,
    externalId,
    title: "Startup indexing plan",
    content,
    contentHash: `${externalId}-${content}-hash`,
    metadata: { documentType: "note" },
    sourceCreatedAt: "2026-01-15T09:00:00.000Z",
    sourceUpdatedAt: "2026-01-15T09:00:00.000Z",
  };
}

function insertDocuments(gatewayDbPath: string, documents: DocumentInput[]): void {
  const gatewayDb = createDatabase(gatewayDbPath);
  try {
    upsertDocuments(gatewayDb, documents);
  } finally {
    gatewayDb.close();
  }
}

function deleteDocumentsBySource(gatewayDbPath: string, sourceId: string): void {
  const gatewayDb = createDatabase(gatewayDbPath);
  try {
    deleteAllBySource(gatewayDb, sourceId);
  } finally {
    gatewayDb.close();
  }
}

function makeWorkerOptions(
  paths: { gatewayDbPath: string; indexDbPath: string; usearchIndexPath: string },
  httpEmbedderUrl: string,
  options: { reindexMissingAtBoot?: boolean; usearchBackfillPageSize?: number } = {},
): IndexerWorkerOptions {
  return {
    modelPath: "(http)",
    modelName: "test-boot-embedder",
    embedDim: EMBED_DIM,
    gatewayDbPath: paths.gatewayDbPath,
    indexDbPath: paths.indexDbPath,
    cutoffs: { default: null, perSource: {} },
    indexIntervalMs: 60 * 60_000,
    indexBacklogIntervalMs: 60 * 60_000,
    dbWriteBatchSize: 50,
    reconcileIntervalMs: 60 * 60_000,
    reindexMissingIntervalMs: 60 * 60_000,
    embedConcurrency: 1,
    indexerPageSize: 50,
    indexerBetweenPageSleepMs: 0,
    reindexMissingAtBoot: options.reindexMissingAtBoot ?? false,
    chunkerChunkSize: 512,
    chunkerOverlap: 64,
    embedderContextSize: 2_048,
    embedderTimeoutMs: 10_000,
    embedderMaxInputChars: 8_000,
    minFreeDiskMb: 0,
    embedderEncoding: NO_ENCODING,
    httpEmbedderUrl,
    httpEmbedderModel: "test-boot-embedder",
    httpEmbedderAllowRemoteInference: false,
    usearchIndexPath: paths.usearchIndexPath,
    usearchBackfillPageSize: options.usearchBackfillPageSize,
  };
}

function createProxy(
  paths: { gatewayDbPath: string; indexDbPath: string; usearchIndexPath: string },
  httpEmbedderUrl: string,
  options: { reindexMissingAtBoot?: boolean; usearchBackfillPageSize?: number } = {},
): IndexerWorkerProxy {
  return new IndexerWorkerProxy(makeWorkerOptions(paths, httpEmbedderUrl, options));
}

function startWorkerWithDeferredDelete(
  paths: { gatewayDbPath: string; indexDbPath: string; usearchIndexPath: string },
  httpEmbedderUrl: string,
  sourceId: string,
): {
  worker: Worker;
  ready: Promise<void>;
  deleted: Promise<number>;
  dispose(): Promise<void>;
} {
  const entry = resolveWorkerEntry("./indexer-worker.ts", import.meta.url, "./register-tsx.mjs");
  const worker = new Worker(entry.url, { execArgv: entry.execArgv });
  const options = makeWorkerOptions(paths, httpEmbedderUrl);
  const init: IndexerInit = {
    type: "init",
    ...options,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
  };
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveDeleted!: (count: number) => void;
  let rejectDeleted!: (error: Error) => void;
  const deleted = new Promise<number>((resolve, reject) => {
    resolveDeleted = resolve;
    rejectDeleted = reject;
  });
  const exit = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  worker.on("message", (message: IndexerToMain) => {
    if (message.type === "ready") resolveReady();
    if (message.type === "initError") rejectReady(new Error(message.error));
    if (message.type === "deleteSourceIndexResult" && message.id === 1) {
      resolveDeleted(message.deleted);
    }
    if (message.type === "deleteSourceIndexError" && message.id === 1) {
      rejectDeleted(new Error(message.error));
    }
    if (message.type === "shutdownComplete") {
      void worker.terminate().catch(() => {});
    }
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectDeleted(error);
  });

  // The protocol permits privacy deletes before init. This deterministic
  // ordering exercises the queue that protects the worker's earliest startup
  // window, before index.db and the write handle exist.
  worker.postMessage({ type: "deleteSourceIndex", id: 1, sourceId });
  worker.postMessage(init);

  return {
    worker,
    ready,
    deleted,
    async dispose() {
      worker.postMessage({ type: "shutdown" });
      await exit;
    },
  };
}

function createFixture(initialDocuments: DocumentInput[]): {
  gatewayDbPath: string;
  indexDbPath: string;
  usearchIndexPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-indexer-boot-"));
  createdDirs.push(dir);
  const graphDir = join(dir, "graph");
  mkdirSync(graphDir);
  const paths = {
    gatewayDbPath: join(dir, "omnesis.db"),
    indexDbPath: join(dir, "index.db"),
    usearchIndexPath: join(graphDir, "index.usearch"),
  };
  insertDocuments(paths.gatewayDbPath, initialDocuments);
  createIndexDatabase(paths.indexDbPath).close();
  return paths;
}

function countVectors(indexDbPath: string): number {
  const indexDb = openIndexDb(indexDbPath, { readonly: true });
  try {
    return (
      indexDb
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL")
        .get()?.c ?? 0
    );
  } finally {
    indexDb.close();
  }
}

async function waitForCycleRuns(proxy: IndexerWorkerProxy, expectedRuns: number): Promise<void> {
  const cycle = proxy.createBackgroundJobs().find((job) => job.id === "indexer.cycle");
  if (!cycle) throw new Error("indexer cycle job was not registered");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const observation = cycle.observe();
    if (observation.state === "erroring" && observation.lastError) {
      throw new Error(`boot indexing failed: ${observation.lastError.message}`);
    }
    if (observation.ticksLastHour >= expectedRuns && !observation.inFlight) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`indexer did not complete ${expectedRuns} cycle(s) within 20 seconds`);
}

async function waitForCycleError(proxy: IndexerWorkerProxy): Promise<string> {
  const cycle = proxy.createBackgroundJobs().find((job) => job.id === "indexer.cycle");
  if (!cycle) throw new Error("indexer cycle job was not registered");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const observation = cycle.observe();
    if (observation.state === "erroring" && observation.lastError) {
      return observation.lastError.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("indexer cycle did not report an error within 20 seconds");
}

async function waitForPartialBackfill(proxy: IndexerWorkerProxy): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const progress = proxy.bootProgress;
    if (progress?.stage === "hnsw-backfill" && progress.progress > 0 && progress.progress < 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("indexer did not report partial HNSW backfill progress within 20 seconds");
}

describe("indexer worker boot persistence", () => {
  test("publishes vectors indexed by the boot-only cycle before shutdown", async () => {
    const paths = createFixture([
      makeDocument(
        "startup-plan-1",
        "Maya Reeves prepared a fictional launch checklist for Studio Northstar.",
      ),
    ]);
    const fakeEmbedder = await startFakeEmbedder();
    const proxy = createProxy(paths, fakeEmbedder.url);

    try {
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);

      // Assert before dispose(): worker shutdown also saves, which would mask
      // the startup bug this regression protects against.
      const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        const writeSeq = getVectorWriteSeq(indexDb);
        expect(writeSeq).toBeGreaterThan(0);
        expect(getUsearchSavedSeq(indexDb)).toBe(writeSeq);
        expect(reader.size()).toBeGreaterThan(0);
      } finally {
        reader.close();
        indexDb.close();
      }
    } finally {
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("coalesces wakes during boot into one trailing cycle", async () => {
    const holdText = "hold the boot embedding request";
    const paths = createFixture([makeDocument("startup-plan-1", holdText)]);
    const fakeEmbedder = await startFakeEmbedder([holdText]);
    const proxy = createProxy(paths, fakeEmbedder.url);

    try {
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;
      insertDocuments(paths.gatewayDbPath, [
        makeDocument("startup-plan-2", "David Lin added a fictional follow-up checklist."),
      ]);
      proxy.wake();
      proxy.wake();
      proxy.wake();
      // MessagePort delivery is FIFO. A query response proves the worker
      // handled all preceding wakes while the boot request was still held.
      await proxy.embedQuery("wake barrier");
      fakeEmbedder.holds[0]!.release();

      await waitForCycleRuns(proxy, 2);
      const cycle = proxy.createBackgroundJobs().find((job) => job.id === "indexer.cycle")!;
      expect(cycle.observe().ticksLastHour).toBe(2);

      const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(getIndexedDocumentCount(indexDb)).toBe(2);
        expect(reader.size()).toBe(2);
      } finally {
        reader.close();
        indexDb.close();
      }
    } finally {
      fakeEmbedder.holds[0]!.release();
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("keeps the vectors when the replacement embedder cannot embed", async () => {
    // A model-identity mismatch at boot (config edited while the gateway was
    // down, an HTTP backend now serving a different model) wipes the vector
    // index for a full re-embed. The warm-up that follows is not retried and a
    // failure is terminal, so wiping before the replacement has embedded even
    // once trades a working index for an empty one on an unreachable server.
    const paths = createFixture([
      makeDocument("startup-plan-1", "Sarah Mendez drafted a fictional migration note."),
    ]);
    const fakeEmbedder = await startFakeEmbedder();
    const first = createProxy(paths, fakeEmbedder.url);
    try {
      await first.whenReady();
      await waitForCycleRuns(first, 1);
    } finally {
      await first.dispose();
    }

    const vectorsBefore = countVectors(paths.indexDbPath);
    expect(vectorsBefore).toBeGreaterThan(0);

    // Second boot: a different model id, and the embedder is gone.
    await closeServer(fakeEmbedder.server);
    const options = makeWorkerOptions(paths, fakeEmbedder.url);
    const swapped = new IndexerWorkerProxy({
      ...options,
      modelName: "replacement-embedder",
      httpEmbedderModel: "replacement-embedder",
    });
    try {
      await expect(swapped.whenReady()).rejects.toThrow();
    } finally {
      await swapped.dispose();
    }

    expect(countVectors(paths.indexDbPath)).toBe(vectorsBefore);
    const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
    try {
      // The stamp still names the model whose vectors are on disk, so the next
      // boot with a reachable embedder still recognises the swap.
      expect(getIndexEmbedModel(indexDb)).toEqual({ name: "test-boot-embedder", dim: EMBED_DIM });
    } finally {
      indexDb.close();
    }
  }, 40_000);

  test("drains a wake that arrived during a reindex-missing pass", async () => {
    const holdText = "hold the reindex-missing embedding request";
    const paths = createFixture([
      makeDocument("startup-plan-1", "Seed content for the boot cycle."),
    ]);
    const fakeEmbedder = await startFakeEmbedder([holdText]);
    const proxy = createProxy(paths, fakeEmbedder.url);

    try {
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);

      // A document the boot cycle's watermark has already passed, so only the
      // repair pass picks it up — and its embed is held open, keeping the
      // exclusivity latch.
      insertDocuments(paths.gatewayDbPath, [makeDocument("startup-plan-2", holdText)]);
      const repair = proxy.reindexMissing();
      await fakeEmbedder.holds[0]!.started;

      // The wake lands while the repair holds the latch, so it can only be
      // remembered. Every periodic interval in this fixture is an hour out,
      // which leaves the drain as the sole path to indexing this document.
      insertDocuments(paths.gatewayDbPath, [
        makeDocument("startup-plan-3", "David Lin filed a fictional status note."),
      ]);
      proxy.wake();
      // MessagePort delivery is FIFO. A query response proves the worker
      // handled the wake while the repair request was still held.
      await proxy.embedQuery("wake barrier");
      fakeEmbedder.holds[0]!.release();
      await repair;

      const deadline = Date.now() + 20_000;
      let indexed = 0;
      while (Date.now() < deadline) {
        const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
        try {
          indexed = getIndexedDocumentCount(indexDb);
        } finally {
          indexDb.close();
        }
        if (indexed >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(indexed).toBe(3);
    } finally {
      fakeEmbedder.holds[0]!.release();
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 40_000);

  test("terminal flush drains the current page and leaves backlog for the next boot", async () => {
    const holdText = "hold boot until flush is pending";
    const paths = createFixture(
      Array.from({ length: 5 }, (_, index) => makeDocument(`startup-plan-${index}`, holdText)),
    );
    const fakeEmbedder = await startFakeEmbedder([holdText]);
    const proxy = new IndexerWorkerProxy({
      ...makeWorkerOptions(paths, fakeEmbedder.url),
      indexerPageSize: 1,
    });

    try {
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;
      let flushSettled = false;
      const flush = proxy.flushSave().then((ok) => {
        flushSettled = true;
        return ok;
      });

      // The query is ordered after flushSave on the worker's MessagePort, but
      // can embed concurrently. Its response proves flush is awaiting boot.
      await proxy.embedQuery("flush barrier");
      expect(flushSettled).toBe(false);
      fakeEmbedder.holds[0]!.release();
      await expect(flush).resolves.toBe(true);

      const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        const writeSeq = getVectorWriteSeq(indexDb);
        expect(writeSeq).toBeGreaterThan(0);
        expect(getUsearchSavedSeq(indexDb)).toBe(writeSeq);
        expect(reader.size()).toBe(1);
        expect(getIndexedDocumentCount(indexDb)).toBe(1);
      } finally {
        reader.close();
        indexDb.close();
      }
      await proxy.dispose();
      // The saved watermark must leave the unfinished pages discoverable.
      const resumed = createProxy(paths, fakeEmbedder.url);
      try {
        await resumed.whenReady();
        await waitForCycleRuns(resumed, 1);
        const resumedDb = openIndexDb(paths.indexDbPath, { readonly: true });
        try {
          expect(getIndexedDocumentCount(resumedDb)).toBe(5);
        } finally {
          resumedDb.close();
        }
      } finally {
        await resumed.dispose();
      }
    } finally {
      fakeEmbedder.holds[0]!.release();
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("does not close worker resources while boot indexing is in flight", async () => {
    const holdText = "hold boot until shutdown is pending";
    const paths = createFixture([makeDocument("startup-plan-1", holdText)]);
    const fakeEmbedder = await startFakeEmbedder([holdText]);
    const proxy = createProxy(paths, fakeEmbedder.url);
    let disposePromise: Promise<void> | undefined;

    try {
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;
      let disposeSettled = false;
      disposePromise = proxy.dispose().then(() => {
        disposeSettled = true;
      });

      // This request is ordered after shutdown on the worker's MessagePort.
      // Its error proves shutdown started and is awaiting the held boot work.
      await expect(proxy.reindexMissing()).rejects.toThrow("indexer shutting down");
      expect(disposeSettled).toBe(false);
      fakeEmbedder.holds[0]!.release();
      await disposePromise;
      expect(disposeSettled).toBe(true);

      const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        const writeSeq = getVectorWriteSeq(indexDb);
        expect(writeSeq).toBeGreaterThan(0);
        expect(getUsearchSavedSeq(indexDb)).toBe(writeSeq);
        expect(reader.size()).toBe(1);
      } finally {
        reader.close();
        indexDb.close();
      }
    } finally {
      fakeEmbedder.holds[0]!.release();
      await (disposePromise ?? proxy.dispose());
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("does not acknowledge a pause while boot indexing is in flight", async () => {
    const holdText = "hold boot until pause is pending";
    const paths = createFixture([makeDocument("startup-plan-1", holdText)]);
    const fakeEmbedder = await startFakeEmbedder([holdText]);
    const proxy = createProxy(paths, fakeEmbedder.url);

    try {
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;
      let pauseSettled = false;
      const pause = proxy.pauseIndexing().then(() => {
        pauseSettled = true;
      });

      // The query is ordered after pauseIndexing on the worker's MessagePort.
      // Its response proves pause is awaiting the held boot work.
      await proxy.embedQuery("pause barrier");
      expect(pauseSettled).toBe(false);
      fakeEmbedder.holds[0]!.release();
      await pause;
      expect(pauseSettled).toBe(true);
    } finally {
      fakeEmbedder.holds[0]!.release();
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("publishes a queued source purge before the next boot phase", async () => {
    const removedSourceId = "synthetic:maya@example.com";
    const survivingSourceId = "synthetic:david@example.com";
    const initialHoldText = "hold the stale source boot embedding";
    const reindexHoldText = "hold the surviving source reindex embedding";
    const paths = createFixture([
      makeDocument("removed-source-plan", initialHoldText, removedSourceId),
    ]);
    const fakeEmbedder = await startFakeEmbedder([initialHoldText, reindexHoldText]);
    const proxy = createProxy(paths, fakeEmbedder.url, { reindexMissingAtBoot: true });

    try {
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;

      // The initial scan already captured its page, so this late document is
      // picked up by the following boot reindex-missing phase.
      insertDocuments(paths.gatewayDbPath, [
        makeDocument("surviving-source-plan", reindexHoldText, survivingSourceId),
      ]);
      deleteDocumentsBySource(paths.gatewayDbPath, removedSourceId);
      await proxy.deleteSourceIndex(removedSourceId);

      fakeEmbedder.holds[0]!.release();
      await fakeEmbedder.holds[1]!.started;

      // Assert while the second phase is held. A finalizer-only purge would
      // leave the deleted source in both index.db and the published graph until
      // every boot phase completed.
      const indexDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        const removedChunks = indexDb
          .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
          .get(removedSourceId)?.c;
        expect(removedChunks).toBe(0);
        expect(getIndexedDocumentCount(indexDb)).toBe(0);
        expect(getUsearchSavedSeq(indexDb)).toBe(getVectorWriteSeq(indexDb));
        expect(reader.size()).toBe(0);
      } finally {
        reader.close();
        indexDb.close();
      }

      fakeEmbedder.holds[1]!.release();
    } finally {
      for (const hold of fakeEmbedder.holds) hold.release();
      await proxy.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 30_000);

  test("replays a queued source purge after failed publication and restart", async () => {
    const sourceId = "synthetic:maya@example.com";
    const externalId = "restart-purge-plan";
    const heldText = "hold the changed source embedding before failed publication";
    const paths = createFixture([
      makeDocument(externalId, "Maya Reeves drafted a fictional equipment checklist.", sourceId),
    ]);
    const fakeEmbedder = await startFakeEmbedder([heldText]);
    const graphDir = dirname(paths.usearchIndexPath);
    const graphDirMode = statSync(graphDir).mode & 0o777;
    let graphReadOnly = false;
    let proxy: IndexerWorkerProxy | undefined;

    try {
      // Seed a durable graph first so the failure leaves a real prior snapshot
      // that the restarted worker must reject or repair.
      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;

      insertDocuments(paths.gatewayDbPath, [makeDocument(externalId, heldText, sourceId)]);
      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();
      await fakeEmbedder.holds[0]!.started;

      deleteDocumentsBySource(paths.gatewayDbPath, sourceId);
      await proxy.deleteSourceIndex(sourceId);
      chmodSync(graphDir, 0o500);
      graphReadOnly = true;
      fakeEmbedder.holds[0]!.release();

      await expect(waitForCycleError(proxy)).resolves.toContain("index publication failed");
      await proxy.dispose();
      proxy = undefined;

      chmodSync(graphDir, graphDirMode);
      graphReadOnly = false;
      const failedDb = openIndexDb(paths.indexDbPath, { readonly: true });
      try {
        expect(listPendingSourceIndexPurges(failedDb)).toEqual([sourceId]);
        expect(getUsearchSavedSeq(failedDb)).not.toBe(getVectorWriteSeq(failedDb));
      } finally {
        failedDb.close();
      }

      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);

      const recoveredDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(listPendingSourceIndexPurges(recoveredDb)).toEqual([]);
        expect(getIndexedDocumentCount(recoveredDb)).toBe(0);
        expect(getUsearchSavedSeq(recoveredDb)).toBe(getVectorWriteSeq(recoveredDb));
        expect(reader.size()).toBe(0);
      } finally {
        reader.close();
        recoveredDb.close();
      }
    } finally {
      fakeEmbedder.holds[0]!.release();
      if (graphReadOnly) chmodSync(graphDir, graphDirMode);
      await proxy?.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 60_000);

  test("does not advertise readiness while a durable source purge cannot be published", async () => {
    const sourceId = "synthetic:maya@example.com";
    const paths = createFixture([
      makeDocument(
        "startup-purge-plan",
        "Maya Reeves drafted a fictional inventory note.",
        sourceId,
      ),
    ]);
    const graphDir = dirname(paths.usearchIndexPath);
    const graphDirMode = statSync(graphDir).mode & 0o777;
    const seedEmbedder = await startFakeEmbedder();
    let proxy: IndexerWorkerProxy | undefined;
    let graphReadOnly = false;

    try {
      proxy = createProxy(paths, seedEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;
      const indexDb = openIndexDb(paths.indexDbPath);
      try {
        deleteDocumentsBySource(paths.gatewayDbPath, sourceId);
        enqueueSourceIndexPurge(indexDb, sourceId);
      } finally {
        indexDb.close();
      }

      chmodSync(graphDir, 0o500);
      graphReadOnly = true;
      proxy = createProxy(paths, seedEmbedder.url);

      await expect(proxy.whenReady()).rejects.toThrow(
        "startup source-index purge publication failed",
      );
      await proxy.dispose();
      proxy = undefined;

      const failedDb = openIndexDb(paths.indexDbPath, { readonly: true });
      try {
        expect(listPendingSourceIndexPurges(failedDb)).toEqual([sourceId]);
      } finally {
        failedDb.close();
      }

      chmodSync(graphDir, graphDirMode);
      graphReadOnly = false;
      proxy = createProxy(paths, seedEmbedder.url);
      await proxy.whenReady();

      const recoveredDb = openIndexDb(paths.indexDbPath, { readonly: true });
      try {
        expect(listPendingSourceIndexPurges(recoveredDb)).toEqual([]);
      } finally {
        recoveredDb.close();
      }
    } finally {
      if (graphReadOnly) chmodSync(graphDir, graphDirMode);
      await proxy?.dispose();
      await closeServer(seedEmbedder.server);
    }
  }, 60_000);

  test("scrubs durable source rows before model warmup and worker readiness", async () => {
    const sourceId = "synthetic:maya@example.com";
    const paths = createFixture([
      makeDocument(
        "pre-listen-purge-plan",
        "Maya Reeves drafted a fictional inventory note.",
        sourceId,
      ),
    ]);
    const seedEmbedder = await startFakeEmbedder();
    let blockingEmbedder: FakeEmbedderServer | undefined;
    let proxy: IndexerWorkerProxy | undefined;

    try {
      proxy = createProxy(paths, seedEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;
      await closeServer(seedEmbedder.server);

      const indexDb = openIndexDb(paths.indexDbPath);
      try {
        deleteDocumentsBySource(paths.gatewayDbPath, sourceId);
        enqueueSourceIndexPurge(indexDb, sourceId);
        expect(scrubPendingSourceIndexPurges(indexDb)).toEqual({
          sourceIds: [sourceId],
          deletedDocuments: 1,
        });
      } finally {
        indexDb.close();
      }

      blockingEmbedder = await startFakeEmbedder(["warmup"]);
      proxy = createProxy(paths, blockingEmbedder.url);
      let readySettled = false;
      const ready = proxy.whenReady().finally(() => {
        readySettled = true;
      });
      await blockingEmbedder.holds[0]!.started;

      const scrubbedDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(readySettled).toBe(false);
        expect(
          scrubbedDb
            .prepare<
              [string],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
            .get(sourceId)?.c,
        ).toBe(0);
        expect(
          scrubbedDb
            .prepare<
              [],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH 'inventory'")
            .get()?.c,
        ).toBe(0);
        expect(listPendingSourceIndexPurges(scrubbedDb)).toEqual([]);
        expect(reader.size()).toBe(0);
      } finally {
        reader.close();
        scrubbedDb.close();
      }

      blockingEmbedder.holds[0]!.release();
      await ready;
    } finally {
      blockingEmbedder?.holds[0]?.release();
      await proxy?.dispose();
      if (blockingEmbedder) await closeServer(blockingEmbedder.server);
      if (seedEmbedder.server.listening) await closeServer(seedEmbedder.server);
    }
  }, 60_000);

  test("accepts a source purge during warmup and boot cannot reintroduce it", async () => {
    const sourceId = "synthetic:maya@example.com";
    const paths = createFixture([
      makeDocument(
        "warmup-handoff-plan",
        "Maya Reeves drafted a fictional handoff checklist.",
        sourceId,
      ),
    ]);
    const seedEmbedder = await startFakeEmbedder();
    let blockingEmbedder: FakeEmbedderServer | undefined;
    let proxy: IndexerWorkerProxy | undefined;

    try {
      proxy = createProxy(paths, seedEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;
      await closeServer(seedEmbedder.server);

      blockingEmbedder = await startFakeEmbedder(["warmup"]);
      proxy = createProxy(paths, blockingEmbedder.url);
      let readySettled = false;
      const ready = proxy.whenReady().finally(() => {
        readySettled = true;
      });
      await blockingEmbedder.holds[0]!.started;

      // The worker owns index.db but has not advertised readiness. The delete
      // must still run through that owner and settle before warmup is released.
      deleteDocumentsBySource(paths.gatewayDbPath, sourceId);
      await expect(proxy.deleteSourceIndex(sourceId)).resolves.toBe(1);
      expect(readySettled).toBe(false);

      const duringWarmupDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const duringWarmupReader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(
          duringWarmupDb
            .prepare<
              [string],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
            .get(sourceId)?.c,
        ).toBe(0);
        expect(listPendingSourceIndexPurges(duringWarmupDb)).toEqual([]);
        expect(
          duringWarmupDb
            .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM pending_vector_deletes")
            .get()?.c,
        ).toBe(0);
        expect(duringWarmupReader.size()).toBe(0);
      } finally {
        duringWarmupReader.close();
        duringWarmupDb.close();
      }

      blockingEmbedder.holds[0]!.release();
      await ready;
      await waitForCycleRuns(proxy, 1);

      const afterBootDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const afterBootReader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(
          afterBootDb
            .prepare<
              [string],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
            .get(sourceId)?.c,
        ).toBe(0);
        expect(afterBootReader.size()).toBe(0);
      } finally {
        afterBootReader.close();
        afterBootDb.close();
      }
    } finally {
      blockingEmbedder?.holds[0]?.release();
      await proxy?.dispose();
      if (blockingEmbedder) await closeServer(blockingEmbedder.server);
      if (seedEmbedder.server.listening) await closeServer(seedEmbedder.server);
    }
  }, 60_000);

  test("services a source purge during cooperative cold backfill", async () => {
    const removedSourceId = "synthetic:maya@example.com";
    const survivingSourceId = "synthetic:david@example.com";
    const documents = [
      makeDocument(
        "cold-backfill-removed-plan",
        "Maya Reeves drafted the fictional moonstone checklist.",
        removedSourceId,
      ),
      ...Array.from({ length: 599 }, (_, index) =>
        makeDocument(
          `cold-backfill-survivor-${index}`,
          `David Lin drafted fictional survivor checklist item ${index}.`,
          survivingSourceId,
        ),
      ),
    ];
    const paths = createFixture(documents);
    const seedEmbedder = await startFakeEmbedder();
    let blockingEmbedder: FakeEmbedderServer | undefined;
    let proxy: IndexerWorkerProxy | undefined;

    try {
      proxy = createProxy(paths, seedEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;
      await closeServer(seedEmbedder.server);

      // Force a cold graph rebuild while retaining the indexed SQLite corpus.
      rmSync(paths.usearchIndexPath, { force: true });
      blockingEmbedder = await startFakeEmbedder(["warmup"]);
      proxy = createProxy(paths, blockingEmbedder.url, { usearchBackfillPageSize: 1 });
      const ready = proxy.whenReady();
      await waitForPartialBackfill(proxy);

      deleteDocumentsBySource(paths.gatewayDbPath, removedSourceId);
      await expect(proxy.deleteSourceIndex(removedSourceId)).resolves.toBe(1);
      expect(proxy.bootProgress?.progress).toBeLessThan(1);

      const duringBackfillDb = openIndexDb(paths.indexDbPath, { readonly: true });
      try {
        expect(
          duringBackfillDb
            .prepare<
              [string],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
            .get(removedSourceId)?.c,
        ).toBe(0);
        expect(
          duringBackfillDb
            .prepare<
              [],
              { c: number }
            >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH 'moonstone'")
            .get()?.c,
        ).toBe(0);
      } finally {
        duringBackfillDb.close();
      }

      await blockingEmbedder.holds[0]!.started;
      blockingEmbedder.holds[0]!.release();
      await ready;

      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(reader.size()).toBe(documents.length - 1);
      } finally {
        reader.close();
      }
    } finally {
      blockingEmbedder?.holds[0]?.release();
      await proxy?.dispose();
      if (blockingEmbedder) await closeServer(blockingEmbedder.server);
      if (seedEmbedder.server.listening) await closeServer(seedEmbedder.server);
    }
  }, 60_000);

  test("a deferred startup delete cannot certify an unrelated stale graph", async () => {
    const removedSourceId = "synthetic:maya@example.com";
    const staleSourceId = "synthetic:david@example.com";
    const survivingSourceId = "synthetic:sarah@example.com";
    const paths = createFixture([
      makeDocument(
        "deferred-delete-plan",
        "Maya Reeves drafted a fictional removal plan.",
        removedSourceId,
      ),
      makeDocument(
        "stale-vector-plan",
        "David Lin drafted a fictional replacement plan.",
        staleSourceId,
      ),
      makeDocument(
        "surviving-vector-plan",
        "Sarah Mendez drafted a fictional surviving plan.",
        survivingSourceId,
      ),
    ]);
    const fakeEmbedder = await startFakeEmbedder();
    let proxy: IndexerWorkerProxy | undefined;
    let raw: ReturnType<typeof startWorkerWithDeferredDelete> | undefined;

    try {
      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;

      const indexDb = openIndexDb(paths.indexDbPath);
      let staleRowid = 0;
      try {
        const stale = indexDb
          .prepare<
            [string],
            { document_id: string; rowid: number }
          >("SELECT document_id, rowid FROM chunks WHERE source_id = ?")
          .get(staleSourceId)!;
        staleRowid = stale.rowid;
        // Insert the replacement before deleting the stale row so SQLite
        // cannot reuse its numeric key. The final DB and graph cardinalities
        // still match, while only SQLite's fingerprint advances because this
        // call deliberately has no live write handle.
        const replacementEmbedding = new Float32Array(EMBED_DIM);
        replacementEmbedding[0] = 1;
        upsertChunks(indexDb, [
          {
            id: "deferred-delete-replacement-chunk",
            documentId: "deferred-delete-replacement-document",
            chunkIndex: 0,
            content: "Fictional replacement vector content.",
            embedding: replacementEmbedding,
            sourceId: staleSourceId,
            title: "Replacement vector",
            sourceCreatedAt: "2026-01-15T09:00:00.000Z",
          },
        ]);
        indexDb.prepare("DELETE FROM chunks WHERE document_id = ?").run(stale.document_id);
        expect(getUsearchSavedSeq(indexDb)).not.toBe(getVectorWriteSeq(indexDb));
      } finally {
        indexDb.close();
      }
      deleteDocumentsBySource(paths.gatewayDbPath, removedSourceId);

      raw = startWorkerWithDeferredDelete(paths, fakeEmbedder.url, removedSourceId);
      await expect(raw.deleted).resolves.toBe(1);
      await raw.ready;

      const recoveredDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        const liveRowids = new Set(
          recoveredDb
            .prepare<[], { rowid: number }>("SELECT rowid FROM chunks ORDER BY rowid")
            .all()
            .map((row) => BigInt(row.rowid)),
        );
        const query = new Float32Array(EMBED_DIM);
        query[0] = 1;
        const graphRowids = new Set(reader.search(query, reader.size()).map((hit) => hit.key));
        expect(graphRowids).toEqual(liveRowids);
        expect(graphRowids.has(BigInt(staleRowid))).toBe(false);
      } finally {
        reader.close();
        recoveredDb.close();
      }
    } finally {
      await proxy?.dispose();
      await raw?.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 60_000);

  test("dispose waits for a pre-ready worker to exit", async () => {
    const paths = createFixture([]);
    const blockingEmbedder = await startFakeEmbedder(["warmup"]);
    const proxy = createProxy(paths, blockingEmbedder.url);
    const readyRejection = expect(proxy.whenReady()).rejects.toThrow(
      "indexer worker shut down before becoming ready",
    );
    const worker = (proxy as unknown as { worker: Worker }).worker;
    let exited = false;
    worker.once("exit", () => {
      exited = true;
    });

    try {
      await blockingEmbedder.holds[0]!.started;
      await proxy.dispose();
      expect(exited).toBe(true);
      await readyRejection;
    } finally {
      blockingEmbedder.holds[0]!.release();
      await proxy.dispose();
      await closeServer(blockingEmbedder.server);
    }
  }, 30_000);

  test("restores a standalone vector-delete obligation when startup publication fails", async () => {
    const paths = createFixture([
      makeDocument("vector-delete-plan-a", "Maya Reeves drafted a fictional lighting plan."),
      makeDocument("vector-delete-plan-b", "David Lin drafted a fictional sound plan."),
    ]);
    const fakeEmbedder = await startFakeEmbedder();
    let proxy: IndexerWorkerProxy | undefined;

    try {
      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();
      await waitForCycleRuns(proxy, 1);
      await proxy.dispose();
      proxy = undefined;

      const indexDb = openIndexDb(paths.indexDbPath);
      try {
        const documentIds = indexDb
          .prepare<[], { document_id: string }>(
            "SELECT document_id FROM indexed_documents ORDER BY document_id",
          )
          .all()
          .map((row) => row.document_id);
        expect(documentIds).toHaveLength(2);

        // Keep the DB and graph cardinalities equal so boot skips backfill:
        // delete one indexed vector (queueing its old rowid) and insert a
        // different SQLite-only vector without changing the graph fingerprint.
        deleteChunksByDocument(indexDb, documentIds[0]!);
        indexDb
          .prepare(
            `INSERT INTO chunks
               (id, document_id, chunk_index, content, source_id, document_type,
                title, source_url, source_created_at, author, tags,
                relevance_score, embedding)
             SELECT
               'replacement-vector-chunk', 'replacement-vector-document', 0,
               content, source_id, document_type, 'Replacement vector plan',
               source_url, source_created_at, author, tags, relevance_score,
               embedding
             FROM chunks
             WHERE document_id = ?`,
          )
          .run(documentIds[1]!);
        expect(
          indexDb
            .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM pending_vector_deletes")
            .get()?.c,
        ).toBe(1);
        expect(
          indexDb.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks").get()?.c,
        ).toBe(2);

        indexDb.exec(`
          CREATE TRIGGER fail_usearch_saved_seq
          BEFORE INSERT ON index_meta
          WHEN NEW.key = 'usearch_saved_seq'
          BEGIN
            SELECT RAISE(ABORT, 'synthetic saved-seq failure');
          END
        `);
      } finally {
        indexDb.close();
      }

      proxy = createProxy(paths, fakeEmbedder.url);
      await expect(proxy.whenReady()).rejects.toThrow("synthetic saved-seq failure");
      await proxy.dispose();
      proxy = undefined;

      const failedDb = openIndexDb(paths.indexDbPath);
      try {
        expect(
          failedDb
            .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM pending_vector_deletes")
            .get()?.c,
        ).toBe(1);
        failedDb.exec("DROP TRIGGER fail_usearch_saved_seq");
      } finally {
        failedDb.close();
      }

      proxy = createProxy(paths, fakeEmbedder.url);
      await proxy.whenReady();

      const recoveredDb = openIndexDb(paths.indexDbPath, { readonly: true });
      const reader = UsearchReadHandle.open(paths.usearchIndexPath, EMBED_DIM);
      try {
        expect(
          recoveredDb
            .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM pending_vector_deletes")
            .get()?.c,
        ).toBe(0);
        expect(reader.size()).toBe(2);
      } finally {
        reader.close();
        recoveredDb.close();
      }
    } finally {
      await proxy?.dispose();
      await closeServer(fakeEmbedder.server);
    }
  }, 60_000);
});
