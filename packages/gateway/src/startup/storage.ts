// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import type { MigrationProgress } from "../data/migrations.js";
import type {
  reconcileIndexForGatewaySchema,
  scrubPendingSourceIndexPurges,
} from "../indexer/db.js";
import type { UsearchGuardResult } from "../indexer/usearch-boot-guard.js";
import type { prepareEncryptedGraphForBoot } from "../indexer/usearch-sidecar-boot.js";

const log = createLogger("gateway:startup:storage");

export interface GatewayDatabaseBoot {
  path: string;
  encryptionKeyHex?: string;
}

export interface GatewayIndexBoot {
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  indexDbPath: string;
  configDir: string;
  indexDbKeyHex?: string;
  storageEncryptionEnabled: boolean;
}

export interface GatewayGraphBootResult {
  restore?: ReturnType<typeof prepareEncryptedGraphForBoot>;
  validated: UsearchGuardResult;
}

export interface GatewayIndexBootResult {
  reconciled: ReturnType<typeof reconcileIndexForGatewaySchema>;
  scrubbed: ReturnType<typeof scrubPendingSourceIndexPurges>;
  interruptedPurges: number;
  graph: GatewayGraphBootResult;
}

export type StorageBootRequest =
  | { operation: "database"; options: GatewayDatabaseBoot }
  | { operation: "index"; options: GatewayIndexBoot };

export type StorageBootMessage =
  | { type: "migration"; progress: MigrationProgress }
  | { type: "done"; result: { frames: number; ms: number } | GatewayIndexBootResult }
  | { type: "error"; message: string };

export interface StorageBootOptions {
  signal?: AbortSignal;
  onMigration?: (progress: MigrationProgress) => void;
}

/** Runs schema creation/migrations before the ordinary writer or any readers open. */
export function initializeGatewayDatabase(
  options: GatewayDatabaseBoot,
  bootOptions: StorageBootOptions = {},
): Promise<{ frames: number; ms: number }> {
  return runStorageWorker({ operation: "database", options }, bootOptions) as Promise<{
    frames: number;
    ms: number;
  }>;
}

/** Prepare the index before its ordinary connection, graph readers or search workers open. */
export function initializeGatewayIndex(
  options: GatewayIndexBoot,
  bootOptions: StorageBootOptions = {},
): Promise<GatewayIndexBootResult> {
  return runStorageWorker(
    { operation: "index", options },
    bootOptions,
  ) as Promise<GatewayIndexBootResult>;
}

function abortError(): Error {
  return new DOMException("Gateway storage initialization cancelled", "AbortError");
}

/** Resolve only after exit, including cancellation: no next phase may race a closing handle. */
function runStorageWorker(
  request: StorageBootRequest,
  options: StorageBootOptions,
): Promise<{ frames: number; ms: number } | GatewayIndexBootResult> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const entry = resolveWorkerEntry(
    "./storage-worker.ts",
    import.meta.url,
    "../workers/register-tsx.mjs",
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData: request });
    let result: { frames: number; ms: number } | GatewayIndexBootResult | undefined;
    let failure: Error | undefined;
    const terminate = (): void => {
      void worker.terminate().catch((err: unknown) => {
        failure ??= err instanceof Error ? err : new Error(String(err));
      });
    };
    const onAbort = (): void => {
      failure = abortError();
      if (request.operation === "index") worker.postMessage({ type: "cancel" });
      else terminate();
    };
    const malformed = (): void => {
      failure ??= new Error("Gateway storage worker returned an invalid message");
      if (request.operation === "index") worker.postMessage({ type: "cancel" });
      else terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Cover an abort between the initial check and listener installation.
    if (options.signal?.aborted) onAbort();
    worker.on("message", (message: unknown) => {
      if (failure) return;
      if (typeof message !== "object" || message === null || !("type" in message)) {
        malformed();
        return;
      }
      const value = message as Record<string, unknown>;
      if (
        value.type === "migration" &&
        request.operation === "database" &&
        isMigrationProgress(value.progress)
      ) {
        try {
          options.onMigration?.(value.progress);
        } catch {
          log.warn("Migration progress observer failed");
        }
      } else if (value.type === "error" && typeof value.message === "string") {
        failure = new Error(value.message);
      } else if (
        value.type === "done" &&
        result === undefined &&
        isResult(request.operation, value.result)
      ) {
        result = value.result;
      } else {
        malformed();
      }
    });
    worker.once("error", (error) => {
      failure ??= error;
    });
    worker.once("exit", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Gateway storage worker exited with code ${code}`));
      else if (result === undefined)
        reject(new Error("Gateway storage worker exited without a result"));
      else resolve(result);
    });
  });
}

function isMigrationProgress(value: unknown): value is MigrationProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Record<string, unknown>;
  return (
    ["planned", "started", "committed", "failed"].includes(String(progress.phase)) &&
    Number.isInteger(progress.current) &&
    Number(progress.current) >= 0 &&
    Number.isInteger(progress.completed) &&
    Number(progress.completed) >= 0 &&
    Number.isInteger(progress.total) &&
    Number(progress.total) >= Number(progress.current) &&
    Number(progress.completed) <= Number(progress.current) &&
    (progress.version === undefined ||
      (Number.isInteger(progress.version) && Number(progress.version) > 0))
  );
}

function isResult(
  operation: StorageBootRequest["operation"],
  value: unknown,
): value is { frames: number; ms: number } | GatewayIndexBootResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (operation === "database")
    return (
      typeof result.frames === "number" &&
      result.frames >= 0 &&
      Number.isFinite(result.frames) &&
      typeof result.ms === "number" &&
      result.ms >= 0 &&
      Number.isFinite(result.ms)
    );
  if (typeof result.graph !== "object" || result.graph === null) return false;
  const graph = result.graph as Record<string, unknown>;
  return (
    ["ok", "absent", "quarantined", "inconclusive"].includes(String(graph.validated)) &&
    typeof result.interruptedPurges === "number" &&
    result.interruptedPurges >= 0 &&
    typeof result.reconciled === "object" &&
    result.reconciled !== null &&
    typeof result.scrubbed === "object" &&
    result.scrubbed !== null
  );
}
