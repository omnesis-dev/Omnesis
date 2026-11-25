// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { z } from "zod";
import { resolveWorkerEntry } from "@omnesis/core";
import type {
  RestoredMainDatabase,
  RestoredMainDatabaseOptions,
  RestoredMainInspection,
} from "./main-database.js";
export type {
  RestoredMainDatabase,
  RestoredMainDatabaseOptions,
  RestoredMainInspection,
} from "./main-database.js";
import type { RestoredMainEntryOptions, RestoredEntryInspectionOptions } from "./entry-main.js";
export type { RestoredMainEntryOptions, RestoredEntryInspectionOptions } from "./entry-main.js";
export { authenticateSqlCipherPages } from "./sqlcipher-page-auth.js";

const resultSchema = z
  .object({
    sourcesPaused: z.number().int().nonnegative().safe(),
    foreignDevicesRetained: z.number().int().nonnegative().safe(),
    targetDevicesPreserved: z.number().int().nonnegative().safe(),
    targetLabs: z.object({ brain: z.boolean(), tasks: z.boolean(), watches: z.boolean() }).strict(),
  })
  .strict();
let active = false;

/**
 * Offline restore only: the desktop caller must hold its opaque runtime leases.
 * The public gateway entry never imports this module or registers a restore API.
 */
export async function reconcileDesktopMainDatabase(
  options: RestoredMainDatabaseOptions,
  signal: AbortSignal,
): Promise<RestoredMainDatabase> {
  return runWorker({ action: "reconcile", ...options }, resultSchema, signal);
}

export async function reconcileDesktopMainEntry(
  options: RestoredMainEntryOptions,
  signal: AbortSignal,
): Promise<RestoredMainDatabase> {
  if (options.entry.targetRootKey.length > 256 || options.entry.sourceRootKey.length > 256)
    throw new Error("The restore keys are unavailable");
  return runWorker({ action: "entry", ...options }, resultSchema, signal);
}
const inspectionSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    sources: z.number().int().nonnegative().safe(),
    documents: z.number().int().nonnegative().safe(),
    devices: z.number().int().nonnegative().safe(),
    legacy: z.boolean(),
  })
  .strict();
export async function inspectDesktopMainEntry(
  options: RestoredEntryInspectionOptions,
  signal: AbortSignal,
): Promise<RestoredMainInspection> {
  return runWorker({ action: "entry-inspect", ...options }, inspectionSchema, signal);
}
async function runWorker<T>(
  options: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  if (active) throw new Error("Another backup database is already being prepared");
  active = true;
  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    void worker?.terminate().catch(() => undefined);
  };
  try {
    const entry = resolveWorkerEntry("./worker.ts", import.meta.url, "../workers/register-tsx.mjs");
    worker = new Worker(entry.url, {
      workerData: options,
      execArgv: entry.execArgv,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    // Workers may initialize ordinary migration loggers; stdout is reserved for
    // the native JSONL protocol, and no raw worker error is forwarded to it.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const joined = new Promise<T>((resolve, reject) => {
      let result: T | undefined;
      let refused = false;
      worker!.on("message", (message: unknown) => {
        if (result || refused) {
          refused = true;
          return;
        }
        if (
          typeof message !== "object" ||
          message === null ||
          !("ok" in message) ||
          message.ok !== true ||
          !("result" in message)
        ) {
          refused = true;
          return;
        }
        const parsed = schema.safeParse(message.result);
        if (parsed.success) result = parsed.data;
        else refused = true;
      });
      worker!.once("error", () => {
        refused = true;
      });
      worker!.once("exit", (code) => {
        if (cancelled || signal.aborted)
          reject(new DOMException("Backup restore was cancelled", "AbortError"));
        else if (code !== 0 || refused || !result)
          reject(new Error("The backup database could not be prepared safely"));
        else resolve(result);
      });
    });
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, 60 * 60_000);
    timer.unref();
    if (signal.aborted) stop();
    return await joined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    active = false;
  }
}
