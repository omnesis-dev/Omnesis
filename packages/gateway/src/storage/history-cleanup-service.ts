// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../http/errors.js";
import {
  listHistoryCleanupJobs,
  readActiveHistoryCleanupJobs,
  readHistoryCleanupJob,
} from "./history-cleanup-store.js";
import type {
  HistoryCleanupAdapter,
  HistoryCleanupJob,
  HistoryCleanupRequest,
  HistoryCleanupTarget,
  StoredHistoryCleanupJob,
} from "./history-cleanup-types.js";
import type { StartHistoryCleanupJob, UpdateHistoryCleanupJob } from "./history-cleanup-store.js";
import type Database from "better-sqlite3";
const log = createLogger("gateway:storage:history-cleanup");

export interface HistoryCleanupWrites {
  startHistoryCleanupJob(input: StartHistoryCleanupJob): Promise<StoredHistoryCleanupJob>;
  updateHistoryCleanupJob(input: UpdateHistoryCleanupJob): Promise<StoredHistoryCleanupJob | null>;
  cancelHistoryCleanupJob(input: {
    id: string;
    now: number;
  }): Promise<StoredHistoryCleanupJob | null>;
}
export interface HistoryCleanupSweepResult {
  hasMore: boolean;
  progressed: boolean;
}
export interface HistoryCleanupServiceOptions {
  db: Database.Database;
  writes: HistoryCleanupWrites;
  adapters: Partial<Record<HistoryCleanupTarget, HistoryCleanupAdapter>>;
  now?: () => number;
}
/** Fixed-cutoff manual commands; every tick performs at most one owned filesystem/cascade unit. */
export class HistoryCleanupService {
  private inFlight: Promise<HistoryCleanupSweepResult> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly ownedJobs = new Map<string, HistoryCleanupTarget>();
  constructor(private readonly options: HistoryCleanupServiceOptions) {}
  /** Restore tiny pending mutation fences before HTTP admission, never drain files at boot. */
  async initialize(): Promise<void> {
    for (const job of readActiveHistoryCleanupJobs(this.options.db)) {
      this.ownedJobs.set(job.id, job.target);
      const reserve = this.options.adapters[job.target]?.reserve;
      if (job.pending && reserve && !(await reserve(job, job.pending)))
        throw new ServiceUnavailableError(
          "Pending history cleanup could not restore its mutation fence",
        );
    }
  }
  jobs(): HistoryCleanupJob[] {
    return listHistoryCleanupJobs(this.options.db).map(publicJob);
  }
  async start(request: HistoryCleanupRequest): Promise<HistoryCleanupJob> {
    const cutoff = Date.parse(request.before);
    if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== request.before)
      throw new BadRequestError("Choose a valid UTC cutoff");
    if (this.closed || !this.options.adapters[request.target])
      throw new ServiceUnavailableError("Cleanup is unavailable for this storage category");
    if (readActiveHistoryCleanupJobs(this.options.db).some((job) => job.target === request.target))
      throw new ConflictError("A cleanup is already running for this storage category");
    const staleOwners = [...this.ownedJobs].filter(([, target]) => target === request.target);
    for (const [id, target] of staleOwners) await this.closeAdapter(id, target);
    try {
      return publicJob(
        await this.options.writes.startHistoryCleanupJob({ request, now: this.now() }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (/A cleanup is already running for this storage category/.test(error.message) ||
          /UNIQUE constraint failed: storage_cleanup_jobs.target/.test(error.message))
      )
        throw new ConflictError("A cleanup is already running for this storage category");
      throw error;
    }
  }
  async cancel(id: string): Promise<HistoryCleanupJob> {
    const job = await this.options.writes.cancelHistoryCleanupJob({ id, now: this.now() });
    if (!job) throw new NotFoundError("Cleanup job not found");
    if (job.state === "cancelled") await this.closeAdapter(id, job.target);
    return publicJob(job);
  }
  sweep(): Promise<HistoryCleanupSweepResult> {
    if (this.closed) return Promise.resolve({ hasMore: false, progressed: false });
    return (this.inFlight ??= (async () => {
      const job = readActiveHistoryCleanupJobs(this.options.db).find(
        (job) =>
          job.state !== "failed" || (job.pending !== null && this.now() - job.updatedAt >= 60000),
      );
      const progressed = job ? await this.step(job) : false;
      return { hasMore: readActiveHistoryCleanupJobs(this.options.db).length > 0, progressed };
    })().finally(() => {
      this.inFlight = null;
    }));
  }
  private async step(job: StoredHistoryCleanupJob): Promise<boolean> {
    const adapter = this.options.adapters[job.target];
    if (!adapter) return false;
    this.ownedJobs.set(job.id, job.target);
    let reservedCandidate: StoredHistoryCleanupJob["pending"] = null;
    try {
      if (!job.pending) {
        const page = await adapter.next(job);
        let candidate = page.candidate;
        let reserved = false;
        if (candidate && adapter.reserve) {
          reserved = await adapter.reserve(job, candidate);
          if (reserved) reservedCandidate = candidate;
          if (!reserved) {
            page.protectedReasons.active = (page.protectedReasons.active ?? 0) + 1;
            candidate = undefined;
          }
        }
        const reasons = { ...(page.resetProtected ? {} : job.protectedReasons) };
        for (const [reason, count] of Object.entries(page.protectedReasons))
          reasons[reason] = (reasons[reason] ?? 0) + count;
        const updated = await this.options.writes.updateHistoryCleanupJob({
          expectedRevision: job.revision,
          job: {
            ...job,
            state: page.done ? "completed" : "running",
            cursor: page.cursor,
            pending: candidate ?? null,
            scanned: job.scanned + page.scanned,
            protectedReasons: reasons,
            protected: Object.values(reasons).reduce((a, b) => a + b, 0),
            updatedAt: this.now(),
            completedAt: page.done ? this.now() : null,
            error: null,
          },
        });
        if (updated?.state === "completed") await this.closeAdapter(job.id, job.target);
        return (
          !!updated &&
          (page.scanned > 0 ||
            !!page.candidate ||
            Object.keys(page.protectedReasons).length > 0 ||
            page.done ||
            page.progressed === true ||
            page.cursor !== job.cursor)
        );
      }
      const outcome = await adapter.remove(job, job.pending);
      if (outcome.state === "pending") {
        await this.options.writes.updateHistoryCleanupJob({
          expectedRevision: job.revision,
          job: { ...job, pending: outcome.candidate ?? job.pending, updatedAt: this.now() },
        });
        return !!outcome.candidate && outcome.candidate.detail !== job.pending.detail;
      }
      // Cancellation may have arrived during an awaited cascade. Read its current
      // revision before acknowledgement so committed cleanup is never abandoned.
      const current = readHistoryCleanupJob(this.options.db, job.id);
      if (!current || current.pending?.id !== job.pending.id) return false;
      const reasons = { ...current.protectedReasons };
      if (outcome.state === "protected")
        reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
      const updated = await this.options.writes.updateHistoryCleanupJob({
        expectedRevision: current.revision,
        job: {
          ...current,
          pending: null,
          state: current.cancelRequested ? "cancelled" : "running",
          removed: current.removed + (outcome.state === "removed" ? 1 : 0),
          removedBytesEstimate:
            current.removedBytesEstimate +
            (outcome.state === "removed" ? outcome.bytesEstimate : 0),
          protectedReasons: reasons,
          protected: Object.values(reasons).reduce((a, b) => a + b, 0),
          updatedAt: this.now(),
          completedAt: current.cancelRequested ? this.now() : null,
          error: null,
        },
      });
      if (updated) await adapter.acknowledge?.(updated, job.pending);
      if (updated?.state === "cancelled") await this.closeAdapter(job.id, job.target);
      return !!updated;
    } catch (error) {
      log.warn(
        `Cleanup failed for ${job.target} (${job.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
      const current = readHistoryCleanupJob(this.options.db, job.id);
      if (current && current.state !== "cancelled" && current.state !== "completed")
        await this.options.writes.updateHistoryCleanupJob({
          expectedRevision: current.revision,
          job: {
            ...current,
            state: "failed",
            updatedAt: this.now(),
            error: current.pending
              ? "Cleanup could not finish. Pending removal will retry."
              : "Cleanup could not finish. Start a new cleanup to retry.",
          },
        });
      if (current && !current.pending) await this.closeAdapter(job.id, job.target);
      return false;
    } finally {
      if (reservedCandidate) {
        const current = readHistoryCleanupJob(this.options.db, job.id);
        if (
          current?.pending?.id !== reservedCandidate.id ||
          current.pending.identity !== reservedCandidate.identity
        )
          await adapter.acknowledge?.(job, reservedCandidate);
      }
    }
  }
  private async closeAdapter(id: string, target: HistoryCleanupTarget): Promise<void> {
    await this.options.adapters[target]?.close?.(id);
    this.ownedJobs.delete(id);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  dispose(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      const errors: unknown[] = [];
      try {
        await this.inFlight;
      } catch (error) {
        errors.push(error);
      }
      // Retain acquired resource identities independently of the reader: an
      // I/O failure must not prevent closing directory handles or mutation fences.
      const jobs = new Map(this.ownedJobs);
      try {
        for (const job of listHistoryCleanupJobs(this.options.db)) jobs.set(job.id, job.target);
      } catch (error) {
        errors.push(error);
      }
      const closures = await Promise.allSettled(
        [...jobs].map(([id, target]) => this.closeAdapter(id, target)),
      );
      for (const result of closures) if (result.status === "rejected") errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, "History cleanup shutdown failed");
    })());
  }
}
function publicJob(job: StoredHistoryCleanupJob): HistoryCleanupJob {
  const { revision, cursor, pending, ...publicValue } = job;
  return { ...publicValue, hasPendingRemoval: pending !== null };
}
