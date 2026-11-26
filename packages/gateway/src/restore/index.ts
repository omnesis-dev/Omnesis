// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { restoreFailureCode, RestoreWorkerFailure } from "./failure.js";
import type { ManagedDesktopDataScope } from "@omnesis/core";
export type DesktopRestoreDataScope = Omit<ManagedDesktopDataScope, "format">;
import { runRestoreProcess } from "./process-launcher.js";
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
import type { RestoredAuxiliaryEntryOptions } from "./auxiliary-entry.js";
import type { AuxiliaryRestoreResult } from "./auxiliary-watch.js";
export type { RestoredAuxiliaryEntryOptions } from "./auxiliary-entry.js";
export type { AuxiliaryRestoreResult } from "./auxiliary-watch.js";
export { authenticateSqlCipherPages } from "./sqlcipher-page-auth.js";

const resultSchema = z
  .object({
    sourcesPaused: z.number().int().nonnegative().safe(),
    recordings: z.number().int().nonnegative().safe(),
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
  dataScope?: DesktopRestoreDataScope,
): Promise<RestoredMainDatabase> {
  return runWorker({ action: "reconcile", ...options }, resultSchema, signal, dataScope);
}

export async function reconcileDesktopMainEntry(
  options: RestoredMainEntryOptions,
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<RestoredMainDatabase> {
  if (options.entry.targetRootKey.length > 256 || options.entry.sourceRootKey.length > 256)
    throw new Error("The restore keys are unavailable");
  return runWorker({ action: "entry", ...options }, resultSchema, signal, dataScope);
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
  dataScope?: DesktopRestoreDataScope,
): Promise<RestoredMainInspection> {
  return runWorker({ action: "entry-inspect", ...options }, inspectionSchema, signal, dataScope);
}
export async function inspectDesktopRestoredDatabase(
  options: { sourcePath: string; sourceKey: Buffer },
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<RestoredMainInspection> {
  return runWorker({ action: "target-inspect", ...options }, inspectionSchema, signal, dataScope);
}
export async function reconcileDesktopSecretEntry(
  options: { entry: import("./entry-stream.js").SealedRestoreEntry; targetPath: string },
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<{ protected: true }> {
  return runWorker(
    { action: "secret", ...options },
    z.object({ protected: z.literal(true) }).strict(),
    signal,
    dataScope,
  );
}
export async function reconcileDesktopConversationEntry(
  options: { entry: import("./entry-stream.js").SealedRestoreEntry; targetPath: string },
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<{ id: string; messages: number }> {
  return runWorker(
    { action: "conversation", ...options },
    z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        messages: z.number().int().nonnegative().safe(),
      })
      .strict(),
    signal,
    dataScope,
  );
}
const auxiliarySchema = z
  .object({
    rowsPreserved: z.number().int().nonnegative().safe(),
    watchesPaused: z.number().int().nonnegative().safe(),
    pendingWorkDiscarded: z.number().int().nonnegative().safe(),
  })
  .strict();
export async function reconcileDesktopAuxiliaryEntry(
  options: Omit<RestoredAuxiliaryEntryOptions, "signal">,
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<AuxiliaryRestoreResult> {
  return runWorker({ action: "auxiliary", ...options }, auxiliarySchema, signal, dataScope);
}
async function runWorker<T>(
  options: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  dataScope?: DesktopRestoreDataScope,
): Promise<T> {
  signal.throwIfAborted();
  if (active) throw new Error("Another backup database is already being prepared");
  active = true;
  try {
    const reply = await runRestoreProcess(options, signal, { dataScope });
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("ok" in reply) ||
      reply.ok !== true ||
      !("result" in reply)
    )
      throw new RestoreWorkerFailure(
        typeof reply === "object" && reply !== null && "failureCode" in reply
          ? (restoreFailureCode(reply.failureCode) ?? "invalid-reply")
          : "invalid-reply",
      );
    const parsed = schema.safeParse(reply.result);
    if (!parsed.success) throw new RestoreWorkerFailure("invalid-result");
    return parsed.data;
  } finally {
    active = false;
  }
}
