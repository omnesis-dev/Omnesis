// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { Worker, type WorkerOptions } from "node:worker_threads";
import { resolveWorkerEntry, createLogger } from "@omnesis/core";
import { shutdownWorker } from "../workers/shutdown-worker.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "../workers/worker-priority.js";
import type {
  AllocationLimits,
  AllocationStore,
  AllocationStoreOptions,
  StorageAllocationSnapshot,
} from "./physical-accounting.js";
export type { AllocationStore, StorageAllocationSnapshot } from "./physical-accounting.js";
const log = createLogger("gateway:storage:allocation");
export interface StorageAllocationReaderOptions extends AllocationLimits {
  gatewayStore: AllocationStoreOptions;
  indexStore: AllocationStoreOptions;
  backgroundWorkerNice?: number;
  createWorker?: (url: URL, options: WorkerOptions) => Worker;
  onProgress?: (store: AllocationStore, snapshot: StorageAllocationSnapshot) => void;
}
interface Pending {
  promise: Promise<StorageAllocationSnapshot>;
  resolve: (value: StorageAllocationSnapshot) => void;
  reject: (error: Error) => void;
}
/** Lazy, background-only ownership; no physical cursor can pin an interactive connection. */
export class StorageAllocationReader {
  private worker: Worker | null = null;
  private readonly cancel = new Int32Array(new SharedArrayBuffer(4));
  private readonly pending = new Map<AllocationStore, Pending>();
  private readonly snapshots = new Map<AllocationStore, StorageAllocationSnapshot>();
  private readonly attempted = new Map<AllocationStore, number>();
  private closing: Promise<void> | null = null;
  constructor(private readonly options: StorageAllocationReaderOptions) {}
  measure(
    store: AllocationStore,
    options: { force?: boolean } = {},
  ): Promise<StorageAllocationSnapshot> {
    if (this.closing) return Promise.reject(new Error("Allocation reader is closed"));
    const existing = this.pending.get(store);
    if (existing) return existing.promise;
    const prior = this.snapshots.get(store);
    if (
      !options.force &&
      prior &&
      prior.state !== "ready" &&
      Date.now() - (this.attempted.get(store) ?? 0) < 60000
    )
      return Promise.resolve(prior);
    this.attempted.set(store, Date.now());
    if (!this.worker) {
      const entry = resolveWorkerEntry(
        "../workers/storage-allocation-worker.ts",
        import.meta.url,
        "../workers/register-tsx.mjs",
      );
      const { onProgress, createWorker, ...options } = this.options;
      const worker = (createWorker ?? ((url, options) => new Worker(url, options)))(entry.url, {
        execArgv: entry.execArgv,
        workerData: {
          ...options,
          backgroundWorkerNice: options.backgroundWorkerNice ?? DEFAULT_BACKGROUND_WORKER_NICE,
          cancel: this.cancel.buffer,
        },
      });
      this.worker = worker;
      worker.on(
        "message",
        (message: {
          store: AllocationStore;
          snapshot: StorageAllocationSnapshot;
          done: boolean;
        }) => {
          if (this.worker !== worker || !message.snapshot) return;
          this.snapshots.set(message.store, message.snapshot);
          if (message.done) {
            this.pending.get(message.store)?.resolve(message.snapshot);
            this.pending.delete(message.store);
          }
          try {
            this.options.onProgress?.(message.store, message.snapshot);
          } catch {
            log.warn("Storage allocation progress callback failed");
          }
        },
      );
      const fail = () => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const item of this.pending.values())
          item.reject(new Error("Allocation worker stopped"));
        this.pending.clear();
        // A crashed attempt is not a capped-result backoff; the next request
        // creates a fresh owner rather than posting into an exited thread.
        for (const [store, snapshot] of this.snapshots) {
          if (snapshot.state === "running") this.snapshots.delete(store);
        }
      };
      worker.on("error", fail);
      worker.on("exit", fail);
    }
    const deferred = Promise.withResolvers<StorageAllocationSnapshot>();
    this.pending.set(store, deferred);
    this.worker.postMessage({ type: "measure", store });
    return deferred.promise;
  }
  dispose(): Promise<void> {
    this.closing ??= (async () => {
      Atomics.store(this.cancel, 0, 1);
      const worker = this.worker;
      if (worker)
        await shutdownWorker(
          worker,
          () => worker.postMessage({ type: "shutdown" }),
          () => log.warn("Storage allocation reader is still draining native page work"),
          { waitForNativeDrain: true },
        );
    })();
    return this.closing;
  }
}
