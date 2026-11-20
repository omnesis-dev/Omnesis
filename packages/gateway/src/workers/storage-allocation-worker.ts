// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { parentPort, workerData } from "node:worker_threads";
import { scanStorageAllocation } from "../storage/physical-accounting.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";
import type { StorageAllocationReaderOptions } from "../storage/allocation-reader.js";
import type { StorageAllocationSnapshot, AllocationStore } from "../storage/physical-accounting.js";
const options = workerData as Omit<StorageAllocationReaderOptions, "onProgress"> & {
  cancel: SharedArrayBuffer;
};
const cancelled = new Int32Array(options.cancel);
const active = new Set<Promise<void>>();
const cache = new Map<AllocationStore, StorageAllocationSnapshot>();
let closing = false;
deprioritizeBackgroundWorker(options.backgroundWorkerNice ?? 10, "storage-allocation");
parentPort!.on("message", (message: { type: "measure" | "shutdown"; store: AllocationStore }) => {
  if (message.type === "shutdown") {
    closing = true;
    Atomics.store(cancelled, 0, 1);
    void Promise.allSettled([...active]).then(() => {
      parentPort!.postMessage({ type: "shutdownComplete" });
      parentPort!.close();
    });
    return;
  }
  if (closing) return;
  const store = message.store;
  const run = (async () => {
    try {
      const snapshot = await scanStorageAllocation(
        store === "documents" ? options.gatewayStore : options.indexStore,
        options,
        () => Atomics.load(cancelled, 0) !== 0,
        (snapshot) => parentPort!.postMessage({ store, snapshot, done: false }),
        cache.get(store),
      );
      cache.set(store, snapshot);
      parentPort!.postMessage({ store, snapshot, done: true });
    } catch {
      const snapshot: StorageAllocationSnapshot = {
        state: "error",
        measuredAt: cache.get(store)?.measuredAt ?? null,
        tables: cache.get(store)?.tables ?? null,
        completed: [],
        scannedPages: 0,
        error: "Allocation measurement failed",
      };
      cache.set(store, snapshot);
      parentPort!.postMessage({ store, snapshot, done: true });
    }
  })();
  active.add(run);
  void run.finally(() => active.delete(run));
});
