// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { IndexerLifecycle, type IndexerLifecycleDeps } from "./indexer-lifecycle.js";
import { IndexerStatusReporter } from "./indexer-status.js";
import {
  createBuildingIndexVersion,
  createIndexDatabase,
  getActiveIndexVersion,
  getBuildingEmbeddingCount,
  getBuildingIndexVersion,
  getIndexedDocumentCount,
  getIndexVersion,
  migrateAdoptInPlaceVersion,
  setIndexEmbedModel,
  setIndexVersionProgress,
  upsertBuildingEmbeddings,
  upsertChunks,
  usearchPathForVersion,
  type ChunkUpsertInput,
} from "./db.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import type { IndexerWorkerProxy } from "../workers/indexer-worker-proxy.js";

// ── Mocks for the modules the lifecycle pulls in ──────────────────────────
// http-embedder is imported dynamically inside startIndexer/runEmbedSwap.
// We mock probeHttpEmbedder (HTTP-embedder swap dimension probe) and
// HttpEmbedder (search-side direct client) so no network is touched.
const probeHttpEmbedder = vi.fn(async () => ({ model: "mock-embed", dim: 64 }));

// One-shot embed gate so a test can park a graceful build mid-pass, inject a
// second swap, then release — exercising abandon-in-flight. Default: no gating.
let pendingEmbedGate: { release: Promise<void>; signalReached: () => void } | null = null;
function armEmbedGate(): { release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let signalReached!: () => void;
  const releaseP = new Promise<void>((r) => (release = r));
  const reachedP = new Promise<void>((r) => (signalReached = r));
  pendingEmbedGate = { release: releaseP, signalReached };
  return { release, reached: reachedP };
}

// Total texts the build/search embedder embedded — the proof that crash-safe
// resume continues from where it left off rather than re-embedding from zero.
let embedTextCount = 0;

class FakeHttpEmbedder {
  constructor(public readonly opts: { outputDim?: number }) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    embedTextCount += texts.length;
    if (pendingEmbedGate) {
      const g = pendingEmbedGate;
      pendingEmbedGate = null; // one-shot — only the first build's embed parks
      g.signalReached();
      await g.release;
    }
    const d = this.opts.outputDim ?? 64;
    return texts.map(() => {
      const a = new Float32Array(d);
      a[0] = 1; // non-degenerate unit vector for the Cos metric
      return a;
    });
  }
  async embedQuery(): Promise<Float32Array> {
    const d = this.opts.outputDim ?? 64;
    const a = new Float32Array(d);
    a[0] = 1;
    return a;
  }
  async dispose(): Promise<void> {}
}
vi.mock("./http-embedder.js", () => ({
  probeHttpEmbedder: (...args: unknown[]) => probeHttpEmbedder(...(args as [])),
  HttpEmbedder: FakeHttpEmbedder,
}));

// withFreshIndexWriteGate runs the wipe callback against a fake gate so we can
// assert the embed-swap orchestration wipes the vector index exactly once.
const wipeAndRecreateVectorIndex = vi.fn();
const directDeleteSourceIndex = vi.fn(async () => 0);
const directDeleteDocumentIndexBatch = vi.fn(async () => ({
  deletedChunks: 0,
  complete: true,
  readyForSourceDelete: false,
}));
const withFreshIndexWriteGate = vi.fn(
  async (
    _path: string,
    fn: (gate: { wipeAndRecreateVectorIndex: typeof wipeAndRecreateVectorIndex }) => unknown,
  ) => fn({ wipeAndRecreateVectorIndex }),
);
vi.mock("./index-write-gate.js", () => ({
  withFreshIndexWriteGate: (...args: unknown[]) => withFreshIndexWriteGate(...(args as [])),
  directIndexWriteGate: vi.fn(() => ({
    deleteIndexBySource: directDeleteSourceIndex,
    deleteChunksByDocumentBatch: directDeleteDocumentIndexBatch,
  })),
}));

// IndexerWorkerProxy is constructed inside startIndexer. We replace it with a
// fake whose lifecycle methods we can spy on. buildIndexerCutoffMap is a pure
// helper — stub it to a trivial map.
const proxyInstances: FakeProxy[] = [];
let nextProxyReadyError: Error | null = null;
let nextProxyReadyGate: Promise<void> | null = null;
class FakeProxy {
  whenReady = vi.fn(async () => {
    if (nextProxyReadyGate) await nextProxyReadyGate;
    if (nextProxyReadyError) throw nextProxyReadyError;
  });
  dispose = vi.fn(async () => {});
  deleteSourceIndex = vi.fn(async () => 0);
  deleteDocumentIndexBatch = vi.fn(async () => ({
    deletedChunks: 0,
    complete: true,
    readyForSourceDelete: false,
  }));
  createBackgroundJobs = vi.fn(() => []);
  updateCutoffs = vi.fn();
  embedQuery = vi.fn(async () => new Float32Array([0.1, 0.2]));
  reindexMissing = vi.fn(async () => ({ queued: 0 }));
  wake = vi.fn();
  // Graceful-for-local quiesce: pause keeps the worker alive as the
  // query embedder; resume un-pauses on abandon. Track whether dispose was called
  // so a test can prove the worker was paused (not disposed) during the quiesce.
  pauseIndexing = vi.fn(async () => {});
  resumeIndexing = vi.fn();
  // Shutdown flush-save: force the HNSW graph to disk before dispose so the next
  // boot restores. Returns whether the graph was persisted.
  flushSave = vi.fn(async () => true);
  readonly opts: Record<string, unknown>;
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    proxyInstances.push(this);
  }
}
vi.mock("../workers/indexer-worker-proxy.js", () => ({
  // A real (non-arrow) function so `new IndexerWorkerProxy(opts)` constructs;
  // returns the spyable FakeProxy. FakeProxy is referenced lazily at call time,
  // after the test module has finished initializing it.
  IndexerWorkerProxy: vi.fn(function (opts: Record<string, unknown>) {
    return new FakeProxy(opts);
  }),
  buildIndexerCutoffMap: vi.fn(() => ({})),
}));

// BuildWorkerEmbedder hosts the NEW local GGUF off the main thread for a
// graceful swap to a LOCAL target (mechanism 1). The real one spawns
// a worker thread + loads a GGUF (CUDA-crashes on this box) — so we replace it
// with a deterministic in-process fake that behaves like FakeHttpEmbedder (same
// embed-gate hook for the abandon-in-flight tests) and records spawn/teardown so
// a test can prove the build worker is created once and torn down (no leak).
const buildWorkerInstances: FakeBuildWorkerEmbedder[] = [];
class FakeBuildWorkerEmbedder {
  dispose = vi.fn(async () => {});
  readonly opts: { embedDim?: number };
  constructor(opts: { embedDim?: number }) {
    this.opts = opts;
    buildWorkerInstances.push(this);
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    embedTextCount += texts.length;
    if (pendingEmbedGate) {
      const g = pendingEmbedGate;
      pendingEmbedGate = null; // one-shot
      g.signalReached();
      await g.release;
    }
    const d = this.opts.embedDim ?? 64;
    return texts.map(() => {
      const a = new Float32Array(d);
      a[0] = 1;
      return a;
    });
  }
  async embedQuery(): Promise<Float32Array> {
    const d = this.opts.embedDim ?? 64;
    const a = new Float32Array(d);
    a[0] = 1;
    return a;
  }
}
vi.mock("../workers/build-embedder-proxy.js", () => ({
  BuildWorkerEmbedder: vi.fn(function (opts: { embedDim?: number }) {
    return new FakeBuildWorkerEmbedder(opts);
  }),
}));

// embedder-prefixes — pure helpers; return deterministic values.
vi.mock("./embedder-prefixes.js", () => ({
  NO_ENCODING: { kind: "none" },
  resolveEmbedderEncoding: () => ({ kind: "text-prefix", query: "q: ", document: "d: " }),
}));

// ── Fake collaborators ────────────────────────────────────────────────────
function makeDeps(overrides: Partial<IndexerLifecycleDeps> = {}): {
  deps: IndexerLifecycleDeps;
  setEmbedder: ReturnType<typeof vi.fn>;
  registerAll: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  statusReporter: IndexerStatusReporter;
} {
  // An HTTP embedder assignment exercises the proxy + search-embedder branch.
  const resolve = vi.fn((role: string) =>
    role === "embedder"
      ? {
          kind: "http",
          url: "http://localhost:9/v1",
          model: "",
          backendKey: "local-http",
          allowRemoteInference: false,
        }
      : { kind: "disabled" },
  );
  const inferenceRegistry = {
    loadConfig: vi.fn(),
    resolve,
    getBackendApiKey: vi.fn(() => undefined),
  } as unknown as IndexerLifecycleDeps["inferenceRegistry"];

  const configStore = {
    get: vi.fn(() => ({ search: { embedderPrefixes: { enabled: false } } })),
  } as unknown as IndexerLifecycleDeps["configStore"];

  const setEmbedder = vi.fn();
  const searchPipeline = {
    setEmbedder,
  } as unknown as IndexerLifecycleDeps["searchPipeline"];

  const registerAll = vi.fn();
  const backgroundJobs = { registerAll } as unknown as IndexerLifecycleDeps["backgroundJobs"];

  const runtime = {
    indexCycleIntervalMs: 1000,
    indexCycleBacklogIntervalMs: 500,
    dbWriteBatchSize: 100,
    reconcileIntervalMs: 2000,
    reindexMissingIntervalMs: 3000,
    embedConcurrency: 2,
    indexerPageSize: 50,
    indexerBetweenPageSleepMs: 0,
    reindexMissingAtBoot: false,
    chunkerChunkSize: 512,
    chunkerOverlap: 64,
    embedderContextSize: 2048,
    embedderTimeoutMs: 30000,
    embedderMaxInputChars: 8000,
  } as unknown as IndexerLifecycleDeps["runtime"];

  const statusReporter = new IndexerStatusReporter();

  const deps: IndexerLifecycleDeps = {
    inferenceRegistry,
    configStore,
    indexerStatus: statusReporter,
    searchPipeline,
    backgroundJobs,
    runtime,
    initialProbe: Promise.resolve(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as IndexerLifecycleDeps["log"],
    gatewayDbPath: "/tmp/omnesis.db",
    indexDbPath: "/tmp/index.db",
    indexDb: createIndexDatabase(":memory:"),
    configDir: "/tmp/cfg",
    initialModelInfo: {
      name: "(discovering...)",
      path: "(http)",
      present: true,
      modelsDir: "/tmp/models",
    },
    ...overrides,
  };
  return { deps, setEmbedder, registerAll, resolve, statusReporter };
}

/** Count on-disk generation usearch files (`index.usearch` / `index-N.usearch`),
 *  ignoring atomic-save `.tmp` siblings — the bounded-to-two invariant. */
function usearchFileCount(dir: string): number {
  return readdirSync(dir).filter((f) => /^index(-\d+)?\.usearch$/.test(f)).length;
}

beforeEach(() => {
  proxyInstances.length = 0;
  buildWorkerInstances.length = 0;
  nextProxyReadyError = null;
  nextProxyReadyGate = null;
  pendingEmbedGate = null;
  embedTextCount = 0;
  vi.clearAllMocks();
  probeHttpEmbedder.mockReset();
  probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: 64 });
});

describe("IndexerLifecycle", () => {
  test("startIndexer brings the worker online and the indexerProxy getter reads through to the live field", async () => {
    const { deps, setEmbedder, registerAll, statusReporter } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);

    // Before boot the getter reads null.
    expect(lifecycle.indexerProxy).toBeNull();

    await lifecycle.startIndexer();

    // Exactly one worker spawned; the getter aliases THAT live instance.
    expect(proxyInstances).toHaveLength(1);
    expect(lifecycle.indexerProxy).toBe(proxyInstances[0]);

    // whenReady awaited before the proxy is exposed; pipeline wired with the
    // direct HTTP search client (HTTP branch), jobs registered, readiness ready.
    expect(proxyInstances[0].whenReady).toHaveBeenCalledOnce();
    expect(setEmbedder).toHaveBeenCalledOnce();
    expect(setEmbedder.mock.calls[0][0]).toBeInstanceOf(FakeHttpEmbedder);
    expect(registerAll).toHaveBeenCalledOnce();
    expect(proxyInstances[0].wake).toHaveBeenCalledOnce();
    expect(statusReporter.getReadiness().status).toBe("ready");
  });

  test("retries a transient HTTP embedder boot race without spawning duplicate workers", async () => {
    vi.useFakeTimers();
    try {
      const { deps, statusReporter } = makeDeps();
      const lifecycle = new IndexerLifecycle(deps);
      probeHttpEmbedder
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ model: "mock-embed", dim: 64 });

      const first = lifecycle.startIndexer();
      const concurrent = lifecycle.startIndexer();
      expect(concurrent).toBe(first);

      await vi.advanceTimersByTimeAsync(10_000);
      await first;

      expect(probeHttpEmbedder).toHaveBeenCalledTimes(2);
      expect(proxyInstances).toHaveLength(1);
      expect(statusReporter.getReadiness()).toEqual({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps recovering after the initial one-minute transient retry window", async () => {
    vi.useFakeTimers();
    try {
      const { deps, statusReporter } = makeDeps();
      const lifecycle = new IndexerLifecycle(deps);
      let attempts = 0;
      probeHttpEmbedder.mockImplementation(() => {
        attempts += 1;
        if (attempts <= 5) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve({ model: "mock-embed", dim: 64 });
      });

      const startup = lifecycle.startIndexer();
      await vi.advanceTimersByTimeAsync(120_000);
      await startup;

      expect(probeHttpEmbedder).toHaveBeenCalledTimes(6);
      expect(proxyInstances).toHaveLength(1);
      expect(statusReporter.getReadiness()).toEqual({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a permanent HTTP embedder configuration error", async () => {
    const { deps, statusReporter } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    probeHttpEmbedder.mockRejectedValueOnce(
      new Error("Embedding probe failed: HTTP 401: unauthorized"),
    );

    await lifecycle.startIndexer();

    expect(probeHttpEmbedder).toHaveBeenCalledOnce();
    expect(proxyInstances).toHaveLength(0);
    expect(statusReporter.getReadiness().status).toBe("failed");
  });

  test("shutdown cancels an HTTP embedder retry before a worker can take index ownership", async () => {
    vi.useFakeTimers();
    try {
      const { deps, statusReporter } = makeDeps();
      const lifecycle = new IndexerLifecycle(deps);
      probeHttpEmbedder
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ model: "mock-embed", dim: 64 });

      const startup = lifecycle.startIndexer();
      await vi.advanceTimersByTimeAsync(0);
      expect(probeHttpEmbedder).toHaveBeenCalledOnce();

      await lifecycle.shutdownIndexer();
      await startup;

      expect(probeHttpEmbedder).toHaveBeenCalledOnce();
      expect(proxyInstances).toHaveLength(0);
      expect(lifecycle.indexerProxy).toBeNull();
      expect(statusReporter.getReadiness().status).toBe("spawning");
    } finally {
      vi.useRealTimers();
    }
  });

  test("shutdown cancels startup while the shared initial backend probe is still pending", async () => {
    const initialProbe = new Promise<void>(() => {});
    const { deps } = makeDeps({ initialProbe });
    const lifecycle = new IndexerLifecycle(deps);

    const startup = lifecycle.startIndexer();
    await lifecycle.shutdownIndexer();
    await startup;

    expect(probeHttpEmbedder).not.toHaveBeenCalled();
    expect(proxyInstances).toHaveLength(0);
  });

  test("a config swap cancels a stale boot retry before the newest model takes index ownership", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "omnesis-boot-swap-race-"));
    try {
      const idxDb = seedActiveGeneration(dir, 32);
      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      let swapStarted = false;
      (deps.inferenceRegistry.resolve as ReturnType<typeof vi.fn>).mockImplementation(
        (role: string) =>
          role === "embedder"
            ? {
                kind: "http",
                url: swapStarted ? "http://new-embedder/v1" : "http://old-embedder/v1",
                model: "",
                backendKey: swapStarted ? "new-http" : "old-http",
                allowRemoteInference: false,
              }
            : { kind: "disabled" },
      );
      const lifecycle = new IndexerLifecycle(deps);
      const attempts = new Map<string, number>();
      probeHttpEmbedder.mockImplementation((url: string) => {
        const count = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, count);
        if (count === 1) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(
          url.includes("new-embedder")
            ? { model: "new-embed", dim: 64 }
            : { model: "old-embed", dim: 32 },
        );
      });

      const boot = lifecycle.startIndexer();
      await vi.advanceTimersByTimeAsync(0);
      expect(probeHttpEmbedder).toHaveBeenCalledOnce();

      swapStarted = true;
      const swap = lifecycle.applyEmbedSwap();
      await vi.advanceTimersByTimeAsync(10_000);
      await swap;
      await boot;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(proxyInstances).toHaveLength(2);
      expect(proxyInstances[0].opts.modelName).toBe("old-embed");
      expect(proxyInstances[0].dispose).toHaveBeenCalledOnce();
      expect(proxyInstances[1].opts.modelName).toBe("new-embed");
      expect(lifecycle.indexerProxy).toBe(proxyInstances[1]);
      expect(getIndexVersion(idxDb, getActiveIndexVersion(idxDb)!)?.embed_dim).toBe(64);
      expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();
      idxDb.close();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalid replacement leaves the boot worker owned until it becomes ready", async () => {
    let releaseReady!: () => void;
    nextProxyReadyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { deps, statusReporter } = makeDeps();
    let swapStarted = false;
    (deps.inferenceRegistry.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      (role: string) =>
        role === "embedder"
          ? {
              kind: "http",
              url: swapStarted ? "http://invalid-embedder/v1" : "http://old-embedder/v1",
              model: "",
              backendKey: swapStarted ? "invalid-http" : "old-http",
              allowRemoteInference: false,
            }
          : { kind: "disabled" },
    );
    const lifecycle = new IndexerLifecycle(deps);
    probeHttpEmbedder.mockResolvedValueOnce({ model: "old-embed", dim: 32 });

    const boot = lifecycle.startIndexer();
    await vi.waitFor(() => expect(proxyInstances).toHaveLength(1));
    const oldWorker = proxyInstances[0];

    swapStarted = true;
    probeHttpEmbedder.mockRejectedValueOnce(
      new Error("Embedding probe failed: HTTP 401 (application/json; 0 bytes)"),
    );
    await lifecycle.applyEmbedSwap();

    expect(oldWorker.dispose).not.toHaveBeenCalled();
    expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();

    releaseReady();
    await boot;
    expect(lifecycle.indexerProxy).toBe(oldWorker);
    expect(statusReporter.getReadiness()).toEqual({ status: "ready" });
  });

  test("shutdown aborts and joins an in-flight HTTP replacement probe", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    await lifecycle.startIndexer();
    const oldWorker = proxyInstances[0];

    let rejectProbe!: (reason: unknown) => void;
    const pendingProbe = new Promise<{ model: string; dim: number }>((_resolve, reject) => {
      rejectProbe = reject;
    });
    probeHttpEmbedder.mockReturnValueOnce(pendingProbe);

    const swap = lifecycle.applyEmbedSwap();
    await vi.waitFor(() => expect(probeHttpEmbedder).toHaveBeenCalledTimes(2));
    const calls = probeHttpEmbedder.mock.calls as unknown[][];
    const opts = calls.at(-1)?.[5] as { signal?: AbortSignal };
    expect(opts.signal?.aborted).toBe(false);

    const shutdown = lifecycle.shutdownIndexer();
    expect(opts.signal?.aborted).toBe(true);
    rejectProbe(opts.signal?.reason ?? new DOMException("aborted", "AbortError"));
    await Promise.all([swap, shutdown]);

    expect(oldWorker.dispose).toHaveBeenCalledOnce();
    expect(proxyInstances).toHaveLength(1);
    expect(lifecycle.indexerProxy).toBeNull();
    expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();
  });

  test("shutdown joins an in-flight graceful swap cleanup without starting a replacement worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-shutdown-swap-"));
    try {
      const idxDb = seedActiveGeneration(dir, 32);
      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);
      probeHttpEmbedder.mockResolvedValue({ model: "old-embed", dim: 32 });
      await lifecycle.startIndexer();

      probeHttpEmbedder.mockResolvedValue({ model: "new-embed", dim: 64 });
      const gate = armEmbedGate();
      const swap = lifecycle.applyEmbedSwap();
      await gate.reached;

      let shutdownSettled = false;
      const shutdown = lifecycle.shutdownIndexer().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      gate.release();
      await Promise.all([swap, shutdown]);

      expect(shutdownSettled).toBe(true);
      expect(proxyInstances).toHaveLength(1);
      expect(lifecycle.indexerProxy).toBeNull();
      expect(getBuildingIndexVersion(idxDb)).toBeNull();
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disposes an indexer worker that fails before becoming ready", async () => {
    const { deps, setEmbedder, registerAll, statusReporter } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    nextProxyReadyError = new Error("startup source-index purge retry failed: graph is read-only");

    await lifecycle.startIndexer();

    expect(proxyInstances).toHaveLength(1);
    expect(proxyInstances[0].dispose).toHaveBeenCalledOnce();
    expect(lifecycle.indexerProxy).toBeNull();
    expect(setEmbedder).not.toHaveBeenCalled();
    expect(registerAll).not.toHaveBeenCalled();
    expect(statusReporter.getReadiness()).toEqual({
      status: "failed",
      reason: "startup source-index purge retry failed: graph is read-only",
    });
  });

  test("retains worker ownership for deletion and shutdown before readiness", async () => {
    let releaseReady!: () => void;
    nextProxyReadyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { deps, registerAll, statusReporter } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    const startup = lifecycle.startIndexer();
    await vi.waitFor(() => expect(proxyInstances).toHaveLength(1));
    const proxy = proxyInstances[0];

    // Ready-only consumers remain gated, but privacy deletion routes to the
    // worker from the instant it owns index.db.
    expect(lifecycle.indexerProxy).toBeNull();
    proxy.deleteSourceIndex.mockResolvedValueOnce(3);
    await expect(lifecycle.deleteSourceIndex("synthetic:maya@example.com")).resolves.toBe(3);
    expect(proxy.deleteSourceIndex).toHaveBeenCalledWith("synthetic:maya@example.com");

    // A shutdown in this startup window must dispose the owner. Releasing the
    // held ready promise afterwards cannot republish the dead proxy.
    await lifecycle.shutdownIndexer();
    expect(proxy.dispose).toHaveBeenCalledOnce();
    releaseReady();
    await startup;
    expect(lifecycle.indexerProxy).toBeNull();
    expect(registerAll).not.toHaveBeenCalled();
    expect(statusReporter.getReadiness().status).toBe("loading-model");
  });

  test("retention refuses a direct fallback while the index writer is shutting down", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    await lifecycle.startIndexer();
    const proxy = proxyInstances[0];
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    proxy.dispose.mockImplementation(async () => disposeGate);

    const shutdown = lifecycle.shutdownIndexer();
    await vi.waitFor(() => expect(proxy.dispose).toHaveBeenCalledOnce());
    let deletionSettled = false;
    const deletion = lifecycle
      .deleteDocumentIndexBatch("doc-during-shutdown", 64, true)
      .then((result) => {
        deletionSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);
    expect(proxy.deleteDocumentIndexBatch).not.toHaveBeenCalled();

    releaseDispose();
    await shutdown;
    await expect(deletion).rejects.toThrow(/shutting down/);
    expect(directDeleteDocumentIndexBatch).not.toHaveBeenCalled();
  });

  test("modelInfo getter returns the SAME mutable object identity and startIndexer mutates it in place", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);

    const before = lifecycle.modelInfo;
    expect(before).toEqual({
      name: "(discovering...)",
      path: "(http)",
      present: true,
      modelsDir: "/tmp/models",
    });

    await lifecycle.startIndexer();

    // Same reference (no copy/spread), now carrying the probed model name.
    expect(lifecycle.modelInfo).toBe(before);
    expect(before.name).toBe("mock-embed");
    expect(before.path).toBe("(http)");

    // A consumer that captured the reference at construction (createServer
    // semantics) sees the mutation without re-reading the getter.
    expect(before.present).toBe(true);
  });

  test("applyEmbedSwap orchestrates shutdown → fresh index-write-gate wipe → restart in order", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);

    await lifecycle.startIndexer();
    const firstProxy = proxyInstances[0];
    expect(firstProxy.dispose).not.toHaveBeenCalled();

    await lifecycle.applyEmbedSwap();

    // Old worker disposed exactly once.
    expect(firstProxy.dispose).toHaveBeenCalledOnce();
    // Vector index wiped through a fresh write gate before respawn.
    expect(withFreshIndexWriteGate).toHaveBeenCalledOnce();
    expect(wipeAndRecreateVectorIndex).toHaveBeenCalledOnce();
    // A new worker spawned and is now the live proxy.
    expect(proxyInstances).toHaveLength(2);
    expect(lifecycle.indexerProxy).toBe(proxyInstances[1]);
    expect(lifecycle.indexerProxy).not.toBe(firstProxy);

    // Ordering: dispose happened before the wipe (null-then-dispose, then wipe).
    const disposeOrder = firstProxy.dispose.mock.invocationCallOrder[0];
    const wipeOrder = wipeAndRecreateVectorIndex.mock.invocationCallOrder[0];
    expect(disposeOrder).toBeLessThan(wipeOrder);
  });

  test("retention waits through a hard-wipe transition and routes to the replacement owner", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    await lifecycle.startIndexer();
    let releaseWipe!: () => void;
    const wipeGate = new Promise<void>((resolve) => {
      releaseWipe = resolve;
    });
    wipeAndRecreateVectorIndex.mockImplementationOnce(async () => wipeGate);

    const swap = lifecycle.applyEmbedSwap("hard");
    await vi.waitFor(() => expect(wipeAndRecreateVectorIndex).toHaveBeenCalledOnce());
    let deletionSettled = false;
    const deletion = lifecycle
      .deleteDocumentIndexBatch("doc-during-hard-swap", 64, true)
      .then((result) => {
        deletionSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);
    expect(directDeleteDocumentIndexBatch).not.toHaveBeenCalled();

    releaseWipe();
    await swap;
    await expect(deletion).resolves.toEqual({
      deletedChunks: 0,
      complete: true,
      readyForSourceDelete: false,
    });
    expect(proxyInstances).toHaveLength(2);
    expect(proxyInstances[1].deleteDocumentIndexBatch).toHaveBeenCalledWith(
      "doc-during-hard-swap",
      64,
      true,
    );
  });

  test("embed swap stamps the SAME identity the fresh worker boots with — no spurious re-wipe", async () => {
    const { deps } = makeDeps();
    const lifecycle = new IndexerLifecycle(deps);
    await lifecycle.startIndexer();

    // The boot path's worker is spawned with the bare served model from the
    // probe (not a backend-prefixed composite) and the probe's native dim.
    expect(proxyInstances[0].opts.modelName).toBe("mock-embed");
    expect(proxyInstances[0].opts.embedDim).toBe(64);

    await lifecycle.applyEmbedSwap();

    // The swap wipes and STAMPS (dim, modelLabel) into index_meta …
    const [stampDim, stampLabel] = wipeAndRecreateVectorIndex.mock.calls[0] as [number, string];
    // … and the fresh worker is spawned with the identity it will compare that
    // stamp against on boot. They MUST be byte-identical, or the worker
    // re-wipes a perfectly valid index on its first cycle:
    // historically the swap stamped `${backendKey}/${model}` while the worker
    // compared the bare served model and the dims could diverge too.
    const freshInit = proxyInstances[1].opts;
    expect(stampLabel).toBe(freshInit.modelName);
    expect(stampDim).toBe(freshInit.embedDim);
    expect(stampLabel).toBe("mock-embed");
    expect(stampDim).toBe(64);
  });

  test("embed swap unlinks the stale usearch file so no stale-dimension index is ever loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-embedswap-"));
    try {
      const { deps } = makeDeps({ configDir: dir });
      const usearch = join(dir, "index.usearch");
      // Simulate the previous model's on-disk HNSW file (built at the old dim)
      // plus a leftover atomic-save temp sibling.
      writeFileSync(usearch, "old-dimension-index-bytes");
      writeFileSync(`${usearch}.tmp`, "partial-save");

      const lifecycle = new IndexerLifecycle(deps);
      await lifecycle.startIndexer();
      expect(existsSync(usearch)).toBe(true);

      await lifecycle.applyEmbedSwap();

      // Both the index file and its temp sibling are gone — the fresh worker
      // starts an empty index at the new dimension and the read handle cannot
      // `view()` a stale-dimension file.
      expect(existsSync(usearch)).toBe(false);
      expect(existsSync(`${usearch}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second swap mid-build abandons the in-flight generation and rebuilds for the newest model — bounded to two files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-abandon-swap-"));
    try {
      // Seed a complete active generation 1 over a small corpus at dim 32.
      const idxDb = createIndexDatabase(join(dir, "index.db"));
      const chunks: ChunkUpsertInput[] = [];
      for (let i = 1; i <= 4; i++) {
        const emb = new Float32Array(32);
        emb[i % 32] = 1;
        chunks.push({
          id: `c-${i}`,
          documentId: `d-${i}`,
          chunkIndex: 0,
          content: `body ${i}`,
          embedding: emb,
          sourceId: "s",
          title: `T${i}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      upsertChunks(idxDb, chunks);
      setIndexEmbedModel(idxDb, "old-embedder", 32);
      migrateAdoptInPlaceVersion(idxDb);
      const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), 32);
      w.backfillFromDb(idxDb);
      w.close();
      expect(getActiveIndexVersion(idxDb)).toBe(1);

      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);
      await lifecycle.startIndexer();

      // First swap → probe dim 64. Park its build mid-pass.
      probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: 64 });
      const gate = armEmbedGate();
      const first = lifecycle.applyEmbedSwap();
      await gate.reached; // generation 2's build is parked in embed()

      // The active pointer has NOT moved; gen 1 still serves; ≤ 2 files on disk.
      expect(getActiveIndexVersion(idxDb)).toBe(1);
      expect(usearchFileCount(dir)).toBeLessThanOrEqual(2);

      // Second swap → newest model is dim 128. This abandons generation 2 and
      // queues a fresh build for the newest model.
      probeHttpEmbedder.mockResolvedValue({ model: "mock-embed-2", dim: 128 });
      const second = lifecycle.applyEmbedSwap();
      gate.release(); // let the abandoned build unwind

      await Promise.all([first, second]);

      // The flip landed the NEWEST model (dim 128) as a fresh generation; the
      // abandoned generation 2 never became active.
      const active = getActiveIndexVersion(idxDb)!;
      expect(active).toBe(3);
      expect(getIndexVersion(idxDb, 1)?.state).toBe("retired");
      expect(getIndexVersion(idxDb, 2)?.state).toBe("retired"); // abandoned
      expect(getIndexVersion(idxDb, 3)?.state).toBe("active");
      expect(getIndexVersion(idxDb, 3)?.embed_dim).toBe(128);
      expect(getIndexVersion(idxDb, 3)?.embed_model).toBe("mock-embed-2");

      // No destructive wipe anywhere on the graceful path.
      expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();

      // Bounded to two on disk → exactly one generation file remains: the
      // abandoned and retired files are both gone, only the new active survives.
      expect(usearchFileCount(dir)).toBe(1);
      expect(existsSync(usearchPathForVersion(dir, 1))).toBe(false);
      expect(existsSync(usearchPathForVersion(dir, 2))).toBe(false);
      expect(existsSync(usearchPathForVersion(dir, 3))).toBe(true);

      // No dangling building rows or staged vectors.
      expect(getBuildingEmbeddingCount(idxDb)).toBe(0);
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash-safe resume: a building generation found at boot is resumed (not restarted from zero), the active generation serves throughout, then the rebuild flips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-resume-"));
    const oneHot = (dim: number, i: number): Float32Array => {
      const v = new Float32Array(dim);
      v[i % dim] = 1;
      return v;
    };
    try {
      const idxDb = createIndexDatabase(join(dir, "index.db"));
      // Active generation 1 over rowids 1..4 at dim 32 (the old model).
      const chunks: ChunkUpsertInput[] = [];
      for (let i = 1; i <= 4; i++) {
        chunks.push({
          id: `c-${i}`,
          documentId: `d-${i}`,
          chunkIndex: 0,
          content: `body ${i}`,
          embedding: oneHot(32, i),
          sourceId: "s",
          title: `T${i}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      upsertChunks(idxDb, chunks);
      setIndexEmbedModel(idxDb, "old-embedder", 32);
      migrateAdoptInPlaceVersion(idxDb);
      const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), 32);
      w.backfillFromDb(idxDb);
      w.close();
      expect(getActiveIndexVersion(idxDb)).toBe(1);

      // A graceful swap to the new model (probe → mock-embed, dim 64) was in
      // flight when the gateway crashed: a building generation 2 exists, with the
      // first TWO chunks already embedded + committed to staging (durable
      // progress), plus a document ingested during the crash window that the
      // still-live worker chunked into the active generation (dim-32 embedding)
      // but that never reached the building generation.
      createBuildingIndexVersion(idxDb, {
        version: 2,
        embedModel: "mock-embed",
        embedDim: 64,
        docsTotal: getIndexedDocumentCount(idxDb),
      });
      upsertBuildingEmbeddings(idxDb, [
        { chunkRowid: 1, embedding: oneHot(64, 1) },
        { chunkRowid: 2, embedding: oneHot(64, 2) },
      ]);
      setIndexVersionProgress(idxDb, 2, 2);
      upsertChunks(idxDb, [
        {
          id: "c-5",
          documentId: "d-5",
          chunkIndex: 0,
          content: "body 5",
          embedding: oneHot(32, 5),
          sourceId: "s",
          title: "T5",
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);

      // ── Reboot: park the resume's embed mid-pass to prove search stays live.
      probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: 64 });
      const gate = armEmbedGate();
      const boot = lifecycle.startIndexer();
      await gate.reached; // resume is embedding the remaining chunks

      // The active pointer has NOT moved to the half-built generation; gen 1
      // keeps serving and its file is intact (search is live across the restart).
      expect(getActiveIndexVersion(idxDb)).toBe(1);
      expect(existsSync(usearchPathForVersion(dir, 1))).toBe(true);
      // No destructive wipe anywhere on the resume path.
      expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();

      gate.release();
      await boot;

      // The rebuild RESUMED and flipped: generation 2 now serves under the new
      // model; the old generation is retired.
      expect(getActiveIndexVersion(idxDb)).toBe(2);
      expect(getIndexVersion(idxDb, 2)?.state).toBe("active");
      expect(getIndexVersion(idxDb, 1)?.state).toBe("retired");
      expect(getIndexVersion(idxDb, 2)?.embed_dim).toBe(64);

      // Only the chunks NOT already staged were embedded — resume, not restart:
      // rowids 3, 4, 5 (the 2 pre-staged were skipped). NOT all 5 from zero.
      expect(embedTextCount).toBe(3);

      // The mid-crash document landed in the resumed generation: its
      // chunks.embedding was promoted to the new dimension at the flip.
      const promoted = idxDb
        .prepare<
          [],
          { embedding: Buffer }
        >("SELECT embedding FROM chunks WHERE document_id = 'd-5'")
        .get();
      expect(promoted?.embedding.byteLength).toBe(64 * 4);

      // No leftover building state; bounded to two → exactly one file on disk.
      expect(getBuildingEmbeddingCount(idxDb)).toBe(0);
      expect(usearchFileCount(dir)).toBe(1);
      expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);
      expect(existsSync(usearchPathForVersion(dir, 1))).toBe(false);
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash-safe resume: an in-flight building generation whose model no longer matches the configured embedder is abandoned, not resumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-resume-mismatch-"));
    try {
      const idxDb = createIndexDatabase(join(dir, "index.db"));
      const chunks: ChunkUpsertInput[] = [];
      for (let i = 1; i <= 3; i++) {
        const emb = new Float32Array(32);
        emb[i % 32] = 1;
        chunks.push({
          id: `c-${i}`,
          documentId: `d-${i}`,
          chunkIndex: 0,
          content: `body ${i}`,
          embedding: emb,
          sourceId: "s",
          title: `T${i}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      upsertChunks(idxDb, chunks);
      setIndexEmbedModel(idxDb, "old-embedder", 32);
      migrateAdoptInPlaceVersion(idxDb);
      const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), 32);
      w.backfillFromDb(idxDb);
      w.close();

      // The building generation was for a DIFFERENT model than the one the
      // gateway now boots with (the operator changed the embedder again while
      // the gateway was down). The probe below reports mock-embed/64.
      createBuildingIndexVersion(idxDb, {
        version: 2,
        embedModel: "some-other-model",
        embedDim: 256,
        docsTotal: getIndexedDocumentCount(idxDb),
      });
      const partial = new UsearchWriteHandle(usearchPathForVersion(dir, 2), 256);
      partial.add(1n, new Float32Array(256).fill(0.1));
      partial.close();
      expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);

      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);
      probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: 64 });

      await lifecycle.startIndexer();

      // The unresumable building generation was abandoned (file + row dropped);
      // the gateway booted normally, the active generation untouched.
      expect(getIndexVersion(idxDb, 2)?.state).toBe("retired");
      expect(existsSync(usearchPathForVersion(dir, 2))).toBe(false);
      expect(getActiveIndexVersion(idxDb)).toBe(1);
      // A normal steady-state worker came online (no resume launched).
      expect(proxyInstances).toHaveLength(1);
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dimension-changing HTTP swap with an active generation goes through the graceful build + flip (no wipe)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-graceful-swap-"));
    try {
      // Seed a complete active generation 1 over a small corpus at dim 32.
      const idxDb = createIndexDatabase(join(dir, "index.db"));
      const chunks: ChunkUpsertInput[] = [];
      for (let i = 1; i <= 4; i++) {
        const emb = new Float32Array(32);
        emb[i % 32] = 1;
        chunks.push({
          id: `c-${i}`,
          documentId: `d-${i}`,
          chunkIndex: 0,
          content: `body ${i}`,
          embedding: emb,
          sourceId: "s",
          title: `T${i}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      upsertChunks(idxDb, chunks);
      setIndexEmbedModel(idxDb, "old-embedder", 32);
      migrateAdoptInPlaceVersion(idxDb);
      const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), 32);
      w.backfillFromDb(idxDb);
      w.close();
      expect(getActiveIndexVersion(idxDb)).toBe(1);

      // The probe reports dim 64 — a dimension-changing swap.
      const { deps } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);
      await lifecycle.startIndexer();

      await lifecycle.applyEmbedSwap();

      // Graceful: NO destructive wipe; the pointer flipped to a new generation.
      expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();
      expect(getActiveIndexVersion(idxDb)).toBe(2);
      expect(getIndexVersion(idxDb, 1)?.state).toBe("retired");
      expect(getIndexVersion(idxDb, 2)?.state).toBe("active");
      expect(getIndexVersion(idxDb, 2)?.embed_dim).toBe(64);
      // Bounded to two on disk → one after the flip.
      expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);
      expect(existsSync(usearchPathForVersion(dir, 1))).toBe(false);
      // The restarted steady-state worker writes the NEW active generation file.
      expect(proxyInstances[1].opts.usearchIndexPath).toBe(usearchPathForVersion(dir, 2));
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hard cutover stops using the old embedder immediately (indexing + query embedding) and rebuilds destructively under the new model — NOT graceful", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-hard-cutover-"));
    try {
      // Same seed as the graceful test: a complete active generation 1 over a
      // small corpus at dim 32. With this seed the DEFAULT swap would go
      // graceful (proven by the test above), so a destructive wipe here is
      // proof the `hard` mode took the immediate-cutover path deliberately.
      const idxDb = createIndexDatabase(join(dir, "index.db"));
      const chunks: ChunkUpsertInput[] = [];
      for (let i = 1; i <= 4; i++) {
        const emb = new Float32Array(32);
        emb[i % 32] = 1;
        chunks.push({
          id: `c-${i}`,
          documentId: `d-${i}`,
          chunkIndex: 0,
          content: `body ${i}`,
          embedding: emb,
          sourceId: "s",
          title: `T${i}`,
          sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      upsertChunks(idxDb, chunks);
      setIndexEmbedModel(idxDb, "old-embedder", 32);
      migrateAdoptInPlaceVersion(idxDb);
      const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), 32);
      w.backfillFromDb(idxDb);
      w.close();
      expect(getActiveIndexVersion(idxDb)).toBe(1);

      const { deps, setEmbedder } = makeDeps({
        indexDb: idxDb,
        indexDbPath: join(dir, "index.db"),
        configDir: dir,
      });
      const lifecycle = new IndexerLifecycle(deps);
      await lifecycle.startIndexer();

      // After boot, the OLD-model query embedder is attached (the search-side
      // HTTP client). Capture it so we can prove it's never used again.
      const oldEmbedder = setEmbedder.mock.calls.at(-1)?.[0] as FakeHttpEmbedder;
      expect(oldEmbedder).toBeInstanceOf(FakeHttpEmbedder);
      const firstProxy = proxyInstances[0];
      setEmbedder.mockClear();

      // The new model is dim 64. Confirm a HARD cutover.
      probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: 64 });
      await lifecycle.applyEmbedSwap("hard");

      // Query embedding stopped immediately: the old embedder was CLEARED
      // (setEmbedder(undefined)) before any destructive wipe ran.
      const clearOrder = setEmbedder.mock.invocationCallOrder[0];
      expect(setEmbedder.mock.calls[0][0]).toBeUndefined();
      // Indexing under the old model stopped immediately: the old worker was
      // disposed before the wipe.
      expect(firstProxy.dispose).toHaveBeenCalledOnce();
      const disposeOrder = firstProxy.dispose.mock.invocationCallOrder[0];
      const wipeOrder = wipeAndRecreateVectorIndex.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(wipeOrder);
      expect(disposeOrder).toBeLessThan(wipeOrder);

      // The hard path is destructive (NOT graceful): the index was wiped at the
      // new dimension and no atomic flip to a fresh generation happened.
      expect(wipeAndRecreateVectorIndex).toHaveBeenCalledOnce();
      const [wipeDim, wipeLabel] = wipeAndRecreateVectorIndex.mock.calls[0] as [number, string];
      expect(wipeDim).toBe(64);
      expect(wipeLabel).toBe("mock-embed");

      // Rebuilt under the NEW model: a fresh worker spawned on it, and the
      // search pipeline re-attached the NEW (not the old) query embedder.
      expect(proxyInstances).toHaveLength(2);
      expect(proxyInstances[1].opts.modelName).toBe("mock-embed");
      expect(proxyInstances[1].opts.embedDim).toBe(64);
      const newEmbedder = setEmbedder.mock.calls.at(-1)?.[0] as FakeHttpEmbedder;
      expect(newEmbedder).toBeInstanceOf(FakeHttpEmbedder);
      expect(newEmbedder).not.toBe(oldEmbedder);
      idxDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shutdownIndexer nulls the proxy first then disposes; is a no-op when never started", async () => {
    const { deps } = makeDeps();
    const neverStarted = new IndexerLifecycle(deps);
    // No handle installed → must not throw.
    await expect(neverStarted.shutdownIndexer()).resolves.toBeUndefined();

    const started = new IndexerLifecycle(makeDeps().deps);
    await started.startIndexer();
    const proxy = proxyInstances[proxyInstances.length - 1];

    await started.shutdownIndexer();
    expect(proxy.dispose).toHaveBeenCalledOnce();
    // Proxy ref dropped after shutdown.
    expect(started.indexerProxy).toBeNull();
  });

  test("flushIndexerSave delegates to the proxy after start, no-ops (false) before start and after shutdown", async () => {
    const neverStarted = new IndexerLifecycle(makeDeps().deps);
    // No proxy yet → nothing to flush → false (the gateway proceeds; boot rebuilds).
    await expect(neverStarted.flushIndexerSave()).resolves.toBe(false);

    const lifecycle = new IndexerLifecycle(makeDeps().deps);
    await lifecycle.startIndexer();
    const proxy = proxyInstances[proxyInstances.length - 1];

    // Delegates to the worker proxy and returns its result.
    proxy.flushSave.mockResolvedValueOnce(true);
    await expect(lifecycle.flushIndexerSave()).resolves.toBe(true);
    expect(proxy.flushSave).toHaveBeenCalledOnce();
    // A save-failure ack (ok=false) propagates so the caller can log it.
    proxy.flushSave.mockResolvedValueOnce(false);
    await expect(lifecycle.flushIndexerSave()).resolves.toBe(false);

    // Ordering guard: shutdownIndexer drops the proxy, so a flush AFTER shutdown
    // can't save — the gateway MUST call flushIndexerSave before shutdownIndexer.
    await lifecycle.shutdownIndexer();
    proxy.flushSave.mockClear();
    await expect(lifecycle.flushIndexerSave()).resolves.toBe(false);
    expect(proxy.flushSave).not.toHaveBeenCalled();
  });

  test("startIndexer bails to disabled when embedder is unresolved (no worker, shutdownIndexer no-ops)", async () => {
    const { deps, statusReporter } = makeDeps();
    (deps.inferenceRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue({
      kind: "unresolved",
      reason: "no backend",
    });
    const lifecycle = new IndexerLifecycle(deps);

    await lifecycle.startIndexer();

    expect(proxyInstances).toHaveLength(0);
    expect(lifecycle.indexerProxy).toBeNull();
    expect(statusReporter.getReadiness().status).toBe("disabled");
    await expect(lifecycle.shutdownIndexer()).resolves.toBeUndefined();
  });
});

// ── Four-transition graceful-swap matrix (option A) ─────────────────────────
//
// The operator locked in full parity: a graceful (zero-downtime) embedder swap
// must hold for ALL FOUR transitions between a LOCAL in-process embedder and an
// HTTP/network-service embedder — local→local, local→http, http→local, http→http.
// This matrix is the feedback loop that pins which transitions meet the graceful
// contract today and which are still PENDING a missing mechanism. It uses the
// deterministic mock embedders the rest of this file already wires (a LOCAL old
// model is simulated by the in-worker FakeProxy query embedder; an HTTP model by
// the FakeHttpEmbedder), at a DIFFERENT dimension across the swap, with NO
// gateway restart.
//
// The graceful contract asserted per transition:
//   - NO destructive wipe (wipeAndRecreateVectorIndex never called);
//   - the query embedder is NEVER cleared to undefined (no BM25-only gap);
//   - for a LOCAL old model the in-worker query embedder is PAUSED (kept alive),
//     not disposed, through the quiesce, and disposed only AFTER the flip
//     (mechanism 2);
//   - for a LOCAL target the NEW model is hosted in a short-lived off-main-thread
//     build worker (mechanism 1) that is spawned once and torn down after the
//     flip — proving the build runs off the event loop with no leaked worker;
//   - the active pointer flips to a fresh generation at the new dimension and
//     the retired generation's file is cleaned up (bounded to two → one).
//
// All four transitions are now graceful-green (option A, full parity): mechanism
// 2 (iter-11) keeps a LOCAL old model's query embedder alive through the quiesce,
// and mechanism 1 (this chunk) hosts a LOCAL target's new model off-thread.

type EmbedderKind = "local" | "http";

function embedderAssignment(kind: EmbedderKind, dim: number): Record<string, unknown> {
  return kind === "http"
    ? {
        kind: "http",
        url: "http://localhost:9/v1",
        model: "",
        backendKey: "local-http",
        allowRemoteInference: false,
      }
    : {
        kind: "local",
        available: true,
        modelPath: "/tmp/matrix-model.gguf",
        catalogId: "local-embed",
        embedDim: dim,
        catalogEntry: { filename: "local-embed.gguf" },
      };
}

/** Seed a complete active generation 1 over a small corpus at `dim`. */
function seedActiveGeneration(dir: string, dim: number): ReturnType<typeof createIndexDatabase> {
  const idxDb = createIndexDatabase(join(dir, "index.db"));
  const chunks: ChunkUpsertInput[] = [];
  for (let i = 1; i <= 4; i++) {
    const emb = new Float32Array(dim);
    emb[i % dim] = 1;
    chunks.push({
      id: `c-${i}`,
      documentId: `d-${i}`,
      chunkIndex: 0,
      content: `body ${i}`,
      embedding: emb,
      sourceId: "s",
      title: `T${i}`,
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  upsertChunks(idxDb, chunks);
  setIndexEmbedModel(idxDb, "old-model", dim);
  migrateAdoptInPlaceVersion(idxDb);
  const w = new UsearchWriteHandle(usearchPathForVersion(dir, 1), dim);
  w.backfillFromDb(idxDb);
  w.close();
  return idxDb;
}

/**
 * Boot the lifecycle under `oldKind` at `oldDim`, then swap to `newKind` at
 * `newDim`. Returns the harness handles for assertions. A stateful resolve()
 * returns the old assignment until the swap is initiated, then the new one (so
 * the post-flip startIndexer also resolves the new model).
 */
async function bootThenSwap(opts: {
  dir: string;
  oldKind: EmbedderKind;
  newKind: EmbedderKind;
  oldDim: number;
  newDim: number;
}): Promise<{
  idxDb: ReturnType<typeof createIndexDatabase>;
  setEmbedder: ReturnType<typeof vi.fn>;
}> {
  const { dir, oldKind, newKind, oldDim, newDim } = opts;
  const idxDb = seedActiveGeneration(dir, oldDim);

  let swapStarted = false;
  const { deps, setEmbedder } = makeDeps({
    indexDb: idxDb,
    indexDbPath: join(dir, "index.db"),
    configDir: dir,
  });
  (deps.inferenceRegistry.resolve as ReturnType<typeof vi.fn>).mockImplementation((role: string) =>
    role === "embedder"
      ? embedderAssignment(swapStarted ? newKind : oldKind, swapStarted ? newDim : oldDim)
      : { kind: "disabled" },
  );

  const lifecycle = new IndexerLifecycle(deps);
  // Boot probe (only consulted for an HTTP old model) reports the old dimension.
  probeHttpEmbedder.mockResolvedValue({ model: "mock-embed", dim: oldDim });
  await lifecycle.startIndexer();

  // Swap: flip the resolver + probe to the new model and apply.
  swapStarted = true;
  probeHttpEmbedder.mockResolvedValue({ model: "mock-embed-new", dim: newDim });
  await lifecycle.applyEmbedSwap();

  return { idxDb, setEmbedder };
}

describe("embedder swap — four-transition graceful matrix (option A)", () => {
  const GREEN: Array<{ oldKind: EmbedderKind; newKind: EmbedderKind }> = [
    { oldKind: "http", newKind: "http" },
    { oldKind: "local", newKind: "http" },
    { oldKind: "http", newKind: "local" },
    { oldKind: "local", newKind: "local" },
  ];

  for (const { oldKind, newKind } of GREEN) {
    test(`${oldKind}→${newKind}: graceful build + atomic flip, query embedder never lost`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `omnesis-matrix-${oldKind}-${newKind}-`));
      try {
        const { idxDb, setEmbedder } = await bootThenSwap({
          dir,
          oldKind,
          newKind,
          oldDim: 32,
          newDim: 64,
        });

        // No destructive wipe on the graceful path.
        expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();
        // The query embedder was NEVER cleared → no BM25-only downtime window.
        expect(setEmbedder.mock.calls.every((c) => c[0] !== undefined)).toBe(true);

        // Atomic flip to a fresh generation at the new dimension; old retired.
        expect(getActiveIndexVersion(idxDb)).toBe(2);
        expect(getIndexVersion(idxDb, 1)?.state).toBe("retired");
        expect(getIndexVersion(idxDb, 2)?.state).toBe("active");
        expect(getIndexVersion(idxDb, 2)?.embed_dim).toBe(64);

        // Bounded to two on disk → exactly one generation file after the flip.
        expect(usearchFileCount(dir)).toBe(1);
        expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);
        expect(existsSync(usearchPathForVersion(dir, 1))).toBe(false);

        const oldWorker = proxyInstances[0];
        if (oldKind === "local") {
          // A LOCAL old model is the search query embedder: it must be PAUSED
          // (kept alive) through the quiesce and disposed only AFTER the flip,
          // so search stays live under the old model the whole time (mechanism 2).
          expect(oldWorker.pauseIndexing).toHaveBeenCalledOnce();
          expect(oldWorker.dispose).toHaveBeenCalledOnce();
          expect(oldWorker.pauseIndexing.mock.invocationCallOrder[0]).toBeLessThan(
            oldWorker.dispose.mock.invocationCallOrder[0],
          );
        } else {
          // An HTTP old model's query embedder is an independent main-thread
          // client, so the worker is just disposed at the quiesce — never paused.
          expect(oldWorker.pauseIndexing).not.toHaveBeenCalled();
          expect(oldWorker.dispose).toHaveBeenCalled();
        }

        if (newKind === "local") {
          // A LOCAL target hosts the new model in a short-lived off-main-thread
          // build worker (mechanism 1): spawned exactly once, torn down after the
          // flip handed query embedding to the fresh steady worker (no leak).
          expect(buildWorkerInstances).toHaveLength(1);
          expect(buildWorkerInstances[0].dispose).toHaveBeenCalledOnce();
        } else {
          // An HTTP target re-embeds via the non-blocking main-thread HTTP
          // client — no build worker is ever spawned.
          expect(buildWorkerInstances).toHaveLength(0);
        }
        idxDb.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("embedder swap — N-rapid-swap stress: bounded to two generations", () => {
  // A burst of embedder swaps fired in rapid succession, each targeting a
  // DIFFERENT dimension so every follow-up is a genuine newest-wins
  // abandon-in-flight (not a coalesced no-op). The invariant under test: at no
  // observed point do more than two `.usearch` generation files exist (one
  // active + at most one building); and after the dust settles exactly one
  // active generation remains at the newest dimension, with no orphan files, no
  // dangling `building` row, and no staged vectors. The old model is HTTP in
  // both variants; `targetKind` toggles the new model between the main-thread
  // HTTP re-embed and the off-main-thread build-worker path (iter-12, mechanism
  // 1, exercised via the FakeBuildWorkerEmbedder which shares the embed gate).
  //
  // Note on sampling: a generation's `.usearch` file is written lazily —
  // `clear()` unlinks any stale file and `save()`/`close()` materialize the new
  // one only at the end of (or every few thousand chunks into) a build. A build
  // parked mid-embed therefore has NO file on disk yet, only its `building` DB
  // row; the deterministic two-file coexistence window (build complete, flip not
  // yet done) is covered by the manual-flip headline test in
  // generation-builder.test.ts. Here the in-flight second generation is observed
  // via its `building` row while the bound asserts the file count never exceeds
  // two through the whole burst and converges to one.
  for (const targetKind of ["http", "local"] as const) {
    test(`${targetKind} target: a rapid burst never exceeds two generation files and converges to one active`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `omnesis-stress-${targetKind}-`));
      try {
        const idxDb = seedActiveGeneration(dir, 32);

        // `currentDim` is the newest configured target dimension; the resolver
        // (local target) and `probeHttpEmbedder` (http target) both read it, so
        // each successive swap targets a fresh model.
        let currentDim = 64;
        let swapStarted = false;
        const { deps } = makeDeps({
          indexDb: idxDb,
          indexDbPath: join(dir, "index.db"),
          configDir: dir,
        });
        (deps.inferenceRegistry.resolve as ReturnType<typeof vi.fn>).mockImplementation(
          (role: string) =>
            role === "embedder"
              ? swapStarted
                ? embedderAssignment(targetKind, currentDim)
                : embedderAssignment("http", 32)
              : { kind: "disabled" },
        );

        const lifecycle = new IndexerLifecycle(deps);
        probeHttpEmbedder.mockResolvedValue({ model: "old", dim: 32 });
        await lifecycle.startIndexer();

        swapStarted = true;
        let maxFiles = 0;
        const sample = (): void => {
          maxFiles = Math.max(maxFiles, usearchFileCount(dir));
        };

        // The FIRST build is parked mid-embed (one-shot gate) so the burst lands
        // while a generation is genuinely in flight — a file on disk, not merely
        // before/after. Subsequent swaps abandon it and coalesce onto a single
        // newest-wins follow-up.
        const dims = [64, 128, 96, 256, 48];
        const gate = armEmbedGate();
        const inflight: Promise<void>[] = [];
        for (let i = 0; i < dims.length; i++) {
          currentDim = dims[i];
          probeHttpEmbedder.mockResolvedValue({ model: `m-${dims[i]}`, dim: dims[i] });
          inflight.push(lifecycle.applyEmbedSwap());
          if (i === 0) await gate.reached; // generation 2 parked mid-embed
          // Sample at every observed point: the old generation still serves, a
          // second generation is genuinely in flight (its `building` row), and
          // at most two generation files exist.
          sample();
          expect(getActiveIndexVersion(idxDb)).toBe(1);
          expect(getBuildingIndexVersion(idxDb)).not.toBeNull();
          expect(usearchFileCount(dir)).toBeLessThanOrEqual(2);
        }

        // Release the parked build → it unwinds (abandoned) and the coalesced
        // follow-up rebuilds for the NEWEST model (dim 48).
        gate.release();
        await Promise.all(inflight);
        sample();

        // The bound held at every observed point: never more than two generation
        // files on disk through the whole burst.
        expect(maxFiles).toBeLessThanOrEqual(2);

        // Converged: exactly one active generation at the newest dimension, no
        // orphan files, no dangling building row, no staged vectors, no wipe.
        const active = getActiveIndexVersion(idxDb)!;
        expect(getIndexVersion(idxDb, active)?.state).toBe("active");
        expect(getIndexVersion(idxDb, active)?.embed_dim).toBe(48);
        expect(usearchFileCount(dir)).toBe(1);
        expect(existsSync(usearchPathForVersion(dir, active))).toBe(true);
        expect(getBuildingIndexVersion(idxDb)).toBeNull();
        expect(getBuildingEmbeddingCount(idxDb)).toBe(0);
        expect(wipeAndRecreateVectorIndex).not.toHaveBeenCalled();
        idxDb.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
