// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";

import { assertNever, createLogger, resolveWorkerEntry } from "@omnesis/core";
import { PendingRequest } from "../workers/pending-request.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "../workers/worker-priority.js";
import { MAX_DF_STAGING_PAIRS_PER_MESSAGE } from "../workers/near-dup-df-staging-protocol.js";
import type { DfChunkResult } from "./NearDupDfCpu.js";
import type {
  MainToNearDupDfStaging,
  NearDupDfStagingToMain,
  NearDupDfStagingWorkerData,
} from "../workers/near-dup-df-staging-protocol.js";

const log = createLogger("gateway:near-dupes:df-staging");
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface NearDupDfStagingWorkerOptions {
  stagingPath: string;
  stagingKey?: Buffer;
  backgroundWorkerNice?: number;
}

export interface NearDupDfStagingResult {
  totalDocs: number;
  uniqueShingles: number;
}

export class NearDupDfStagingWorker {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest<NearDupDfStagingResult | void>>();
  private disposed = false;
  private workerExited = false;

  constructor(options: NearDupDfStagingWorkerOptions) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A caller may abort before its first operation awaits readiness. Keep
    // that legitimate teardown race from becoming an unhandled rejection;
    // awaiting `ready` still observes the original rejection.
    void this.ready.catch(() => undefined);
    const entry = resolveWorkerEntry(
      "../workers/near-dup-df-staging-worker.ts",
      import.meta.url,
      "../workers/register-tsx.mjs",
    );
    const data: NearDupDfStagingWorkerData = {
      stagingPath: options.stagingPath,
      ...(options.stagingKey ? { stagingKeyHex: options.stagingKey.toString("hex") } : {}),
      backgroundWorkerNice: options.backgroundWorkerNice ?? DEFAULT_BACKGROUND_WORKER_NICE,
    };
    this.worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData: data });
    this.worker.on("message", (message: NearDupDfStagingToMain) => this.handleMessage(message));
    this.worker.on("error", (error) => this.failAll(error));
    this.worker.on("exit", (code) => {
      this.workerExited = true;
      if (!this.disposed)
        this.failAll(new Error(`near-dup DF staging worker exited unexpectedly with code ${code}`));
    });
  }

  async add(results: DfChunkResult[]): Promise<void> {
    await this.ready;
    let pendingDocs = 0;
    let pendingPairs: Array<[string, number]> = [];
    let sent = false;

    const flush = async (): Promise<void> => {
      await this.request<void>({
        type: "add",
        id: this.nextId,
        result: { docsProcessed: pendingDocs, shingleCounts: pendingPairs },
      });
      sent = true;
      pendingDocs = 0;
      pendingPairs = [];
    };

    for (const result of results) {
      pendingDocs += result.docsProcessed;
      let offset = 0;
      while (offset < result.shingleCounts.length) {
        const take = Math.min(
          MAX_DF_STAGING_PAIRS_PER_MESSAGE - pendingPairs.length,
          result.shingleCounts.length - offset,
        );
        pendingPairs.push(...result.shingleCounts.slice(offset, offset + take));
        offset += take;
        if (pendingPairs.length === MAX_DF_STAGING_PAIRS_PER_MESSAGE) await flush();
      }
    }
    if (pendingDocs > 0 || pendingPairs.length > 0 || !sent) await flush();
  }

  async finish(minDf: number): Promise<NearDupDfStagingResult> {
    await this.ready;
    return this.request<NearDupDfStagingResult>({ type: "finish", id: this.nextId, minDf });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.workerExited) return;

    const shutdown = new Promise<void>((resolve) => {
      const onMessage = (message: NearDupDfStagingToMain): void => {
        if (message.type !== "shutdownComplete") return;
        this.worker.off("message", onMessage);
        resolve();
      };
      this.worker.on("message", onMessage);
      this.worker.postMessage({ type: "shutdown" } satisfies MainToNearDupDfStaging);
    });
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([shutdown, timeout]);
    await this.worker.terminate().catch(() => undefined);
    this.workerExited = true;
    this.failPending(new Error("near-dup DF staging worker disposed"));
  }

  private request<T>(message: MainToNearDupDfStaging & { id: number }): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("near-dup DF staging worker is disposed"));
    const id = this.nextId++;
    const request = new PendingRequest<NearDupDfStagingResult | void>(OPERATION_TIMEOUT_MS, () => {
      const pending = this.pending.get(id);
      if (pending && this.pending.delete(id)) {
        pending.fail(
          new Error(`near-dup DF staging operation timed out after ${OPERATION_TIMEOUT_MS}ms`),
        );
      }
    });
    this.pending.set(id, request);
    try {
      this.worker.postMessage({ ...message, id });
    } catch (error) {
      this.pending.delete(id);
      request.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return request.promise as Promise<T>;
  }

  private handleMessage(message: NearDupDfStagingToMain): void {
    switch (message.type) {
      case "ready":
        if (!this.readySettled) {
          this.readySettled = true;
          this.resolveReady();
        }
        break;
      case "initError":
        this.failAll(new Error(message.error));
        break;
      case "addResult":
        this.settle(message.id, undefined);
        break;
      case "finishResult":
        this.settle(message.id, {
          totalDocs: message.totalDocs,
          uniqueShingles: message.uniqueShingles,
        });
        break;
      case "operationError":
        this.reject(message.id, new Error(message.error));
        break;
      case "log":
        log.warn(message.message);
        break;
      case "shutdownComplete":
        break;
      default:
        assertNever(message);
    }
  }

  private settle(id: number, value: NearDupDfStagingResult | void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.settle(value);
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.fail(error);
  }

  private failAll(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    this.failPending(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.fail(error);
    this.pending.clear();
  }
}
