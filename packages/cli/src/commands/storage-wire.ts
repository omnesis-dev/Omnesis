// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { CliError, EXIT_GATEWAY_ERROR, gatewayFetch, pickGatewayExitCode } from "../utils.js";

const count = z.number().int().nonnegative();
const state = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
const target = z.enum(["brain-transcripts", "conversations", "backups"]);
const common = { id: z.uuid(), before: z.string(), state, error: z.string().nullable() };
export const trimJobSchema = z
  .object({
    ...common,
    kind: z.enum(["manual", "rolling"]),
    sourceId: z.string(),
    deleted: count,
    examinedDocuments: count,
    skippedDocuments: count,
    cleanupPending: z.boolean(),
  })
  .passthrough();
export const cleanupJobSchema = z
  .object({
    ...common,
    target,
    scanned: count,
    removed: count,
    protected: count,
    protectedReasons: z.record(z.string(), count),
    removedBytesEstimate: count,
    cancelRequested: z.boolean(),
    hasPendingRemoval: z.boolean(),
    keepNewest: z.boolean().optional(),
  })
  .passthrough();
const component = z.object({ id: z.string(), label: z.string(), bytes: count }).passthrough();
const month = z.object({ month: z.string(), documents: count, payloadBytes: count }).passthrough();
const source = z
  .object({ sourceId: z.string(), documents: count, payloadBytes: count, months: z.array(month) })
  .passthrough();
const indexSource = z
  .object({
    sourceId: z.string(),
    month: z.string(),
    chunkCount: count,
    textBytes: count,
    embeddingBytes: count,
  })
  .passthrough();
const measurement = z
  .object({
    state: z.enum(["pending", "refreshing", "ready", "failed"]),
    measuredAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .passthrough();
export const storageSnapshotSchema = z
  .object({
    physical: z
      .object({
        totalBytes: count,
        measuredAt: z.string(),
        stores: z.array(component.extend({ components: z.array(component).optional() })),
      })
      .passthrough()
      .nullable(),
    logical: z
      .object({ measuredAt: z.string(), sources: z.array(source) })
      .passthrough()
      .nullable(),
    index: z
      .object({
        measuredAt: z.string(),
        lexicalBytes: count.nullable(),
        embeddingBytes: count,
        sources: z.array(indexSource),
      })
      .passthrough()
      .nullable(),
    pressure: z
      .object({
        state: z.enum(["normal", "warning", "blocked", "unknown"]),
        reasons: z.array(z.string()),
        volumes: z.array(
          z.object({ id: z.string(), totalBytes: count, availableBytes: count }).passthrough(),
        ),
      })
      .passthrough(),
    policy: z
      .object({
        maxBytes: count.nullable(),
        maxDiskUsedPercent: z.number(),
        resumeMarginPercent: z.number(),
        minFreeBytes: count.optional(),
      })
      .passthrough(),
    retention: z.array(z.object({ sourceId: z.string(), maxAgeDays: count }).passthrough()),
    trimJobs: z.array(trimJobSchema),
    cleanupJobs: z.array(cleanupJobSchema).optional(),
    accounting: z
      .object({
        refreshing: z.boolean(),
        measuredAt: z.string().nullable(),
        error: z.string().nullable(),
        logical: measurement.optional(),
        index: measurement.optional(),
        allocations: measurement
          .extend({
            progress: z
              .object({
                store: z.string(),
                scannedPages: count,
                completedTables: count,
                scannedBytes: count.optional(),
              })
              .passthrough()
              .optional(),
          })
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type StorageSnapshot = z.infer<typeof storageSnapshotSchema>;
export type TrimJob = z.infer<typeof trimJobSchema>;
export type CleanupJob = z.infer<typeof cleanupJobSchema>;
export type StorageJob = TrimJob | CleanupJob;
export type CleanupTarget = z.infer<typeof target>;

/** Validate gateway responses before interpreting progress or claiming a successful mutation. */
export async function storageRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  let response: Response;
  try {
    response = await gatewayFetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CliError(
      `Storage request failed: ${error instanceof Error ? error.message : String(error)}. Any accepted background job continues on the gateway.`,
      EXIT_GATEWAY_ERROR,
    );
  }
  if (!response.ok) {
    if (response.status === 404 && path.startsWith("/admin/storage/jobs/"))
      throw new CliError(
        "Storage job not found, or this gateway does not support direct storage job lookup. Check the complete job ID and upgrade the gateway if needed; completion cannot be confirmed.",
        pickGatewayExitCode(404),
      );
    if (response.status === 404 && path.startsWith("/admin/storage/cleanup"))
      throw new CliError(
        "This gateway does not provide history cleanup, or the requested cleanup job no longer exists. Check the job ID and upgrade the gateway if cleanup is unavailable.",
        pickGatewayExitCode(404),
      );
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new CliError(
      `Storage request rejected (${response.status}): ${detail}`,
      pickGatewayExitCode(response.status),
    );
  }
  const data = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new CliError(
      "The gateway returned an invalid storage response; no completion can be confirmed. Check gateway/CLI versions.",
      EXIT_GATEWAY_ERROR,
    );
  return parsed.data;
}

export const readStorage = (timeoutMs?: number) =>
  storageRequest("/admin/storage", storageSnapshotSchema, {}, timeoutMs);
export async function readStorageJob(id: string, timeoutMs?: number) {
  const result = await storageRequest(
    `/admin/storage/jobs/${encodeURIComponent(id)}`,
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("trim"), job: trimJobSchema }),
      z.object({ kind: z.literal("cleanup"), job: cleanupJobSchema }),
    ]),
    {},
    timeoutMs,
  );
  if (result.job.id !== id)
    throw new CliError(
      `Storage job response did not match requested ID ${id}; completion cannot be confirmed.`,
      EXIT_GATEWAY_ERROR,
    );
  return result;
}
export function storageJobs(snapshot: StorageSnapshot): StorageJob[] {
  return [...snapshot.trimJobs, ...(snapshot.cleanupJobs ?? [])];
}
export function storageSourceProjection(snapshot: StorageSnapshot, sourceId: string) {
  const source = snapshot.logical?.sources.find((item) => item.sourceId === sourceId);
  return {
    sourceId,
    documentMeasurement: source ? { ...source, measuredAt: snapshot.logical!.measuredAt } : null,
    indexMeasurement: snapshot.index
      ? {
          measuredAt: snapshot.index.measuredAt,
          rows: snapshot.index.sources.filter((row) => row.sourceId === sourceId),
        }
      : null,
    retentionPolicy: snapshot.retention.find((policy) => policy.sourceId === sourceId) ?? null,
    trimJobs: snapshot.trimJobs.filter((job) => job.sourceId === sourceId),
    accounting: snapshot.accounting ?? null,
  };
}
export function historyJob(job: StorageJob): job is CleanupJob {
  return typeof job.target === "string";
}
export function pendingStorageJob(job: StorageJob): boolean {
  return (
    job.state === "queued" ||
    job.state === "running" ||
    (historyJob(job) ? job.hasPendingRemoval : job.cleanupPending)
  );
}
