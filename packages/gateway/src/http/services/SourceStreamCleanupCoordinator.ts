// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLogger } from "@omnesis/core";
import {
  isCurrentSourceStreamCleanup,
  listPendingSourceStreamCleanups,
  type SourceStreamCleanupJob,
} from "../../data/repositories/SourceStreamCleanupRepository.js";
import { runWithPriority } from "../../priority.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";
import type { StatusCache } from "./StatusCache.js";
import type { SourceDataRemovalService } from "./SourceDataRemovalService.js";

const log = createLogger("gateway:http").child("sources:stream-cleanup");
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

export interface SourceStreamCleanupCoordinatorDeps {
  db: Database.Database;
  writeGate: WriteGate;
  sourceDataRemoval: SourceDataRemovalService;
  statusCache: StatusCache;
}

/**
 * Drains partitioned streams after the writer has atomically retired their
 * membership and cursor authority. The durable journal makes every store
 * cleanup retryable across transient failures and gateway restarts.
 */
export class SourceStreamCleanupCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(private readonly deps: SourceStreamCleanupCoordinatorDeps) {}

  /** Attempt now; a failed attempt is recorded and scheduled without undoing membership. */
  cleanup(job: SourceStreamCleanupJob): Promise<void> {
    const key = this.key(job);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const attempt = Promise.resolve(runWithPriority("background", () => this.run(job))).finally(
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, attempt);
    return attempt;
  }

  /** Resume interrupted jobs once at boot. */
  resumePending(): void {
    if (this.disposed) return;
    const pending = listPendingSourceStreamCleanups(this.deps.db);
    if (pending.length === 0) return;
    log.info(`Resuming ${pending.length} unfinished member stream cleanup(s)`);
    for (const job of pending) void this.cleanup(job);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async run(job: SourceStreamCleanupJob): Promise<void> {
    if (!isCurrentSourceStreamCleanup(this.deps.db, job)) return;
    const key = this.key(job);
    try {
      await this.deps.sourceDataRemoval.deleteStream(job.sourceId, job.deviceId);
      if (await this.deps.writeGate.completeSourceStreamCleanup(job)) {
        const timer = this.retryTimers.get(key);
        if (timer) clearTimeout(timer);
        this.retryTimers.delete(key);
        log.info(`Member stream cleanup finished for ${job.sourceId} on device ${job.deviceId}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await this.deps.writeGate.recordSourceStreamCleanupFailure(job, message)) {
        log.warn(
          `Member stream cleanup for ${job.sourceId} on device ${job.deviceId} failed: ${message}`,
        );
        this.scheduleRetry(job);
      }
    } finally {
      // SQLite deletion may have committed before an index or analytics arm
      // failed, so every attempted pass invalidates cached document counts.
      this.deps.statusCache.bump();
    }
  }

  private scheduleRetry(job: SourceStreamCleanupJob): void {
    if (this.disposed) return;
    const key = this.key(job);
    if (this.retryTimers.has(key)) return;
    const delayMs = Math.min(RETRY_BASE_MS * 2 ** job.attempts, RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.cleanup({ ...job, attempts: job.attempts + 1 });
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  private key(job: SourceStreamCleanupJob): string {
    return `${job.sourceId}\0${job.deviceId}\0${job.generation}`;
  }
}
