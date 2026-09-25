// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import {
  getSourceModeTransition,
  getSourceModeTransitionPublication,
  listPendingSourceModeTransitions,
  listSourceModeTransitionPublications,
  type SourceModeTransition,
} from "../../data/repositories/SourceModeTransitionRepository.js";
import type { DeviceId, MultiDeviceMode, SourceId } from "@omnesis/types";
import type { WriteGate } from "../../write-gate.js";
import type { PairingGenerationFence } from "../../data/pairing-generation-fence.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
const log = createLogger("gateway:http").child("source-mode-transition");
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

/** Cross-store adoption implemented by the analytics plane. It must be idempotent. */
export interface SourceModeTransitionAdoption {
  adoptExclusiveToPartitioned(sourceId: SourceId, ownerDeviceId: DeviceId): Promise<void>;
}

export class SourceModeTransitionCoordinator {
  private readonly inFlight = new Map<SourceId, Promise<void>>();
  private readonly retryTimers = new Map<SourceId, NodeJS.Timeout>();
  private readonly failures = new Map<SourceId, number>();
  private disposed = false;

  constructor(
    private readonly deps: {
      db: Db;
      writeGate: WriteGate;
      adoption: SourceModeTransitionAdoption;
      onCompleted?: (sourceId: SourceId) => void | Promise<void>;
      retryBaseMs?: number;
      retryMaxMs?: number;
    },
  ) {}

  async transition(
    sourceId: SourceId,
    toMode: MultiDeviceMode,
    expectedOwnerDeviceId: DeviceId,
    memberScopedParams: readonly string[],
    replicaVersionPolicy?: "source-updated-at",
    pairingFence?: PairingGenerationFence,
  ): Promise<void> {
    const pending = await this.deps.writeGate.prepareSourceModeTransition(
      sourceId,
      toMode,
      expectedOwnerDeviceId,
      memberScopedParams,
      replicaVersionPolicy,
      pairingFence,
    );
    if (!pending) return;
    await this.resumeOne(pending);
  }

  resumePending(): void {
    for (const pending of listPendingSourceModeTransitions(this.deps.db)) {
      void this.resumeOne(pending).catch((error: unknown) => {
        log.warn(
          `Source mode transition for ${pending.sourceId} remains pending: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    for (const publication of listSourceModeTransitionPublications(this.deps.db)) {
      void this.resumePublication(publication.sourceId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async resumeOne(pending: SourceModeTransition): Promise<void> {
    const existing = this.inFlight.get(pending.sourceId);
    if (existing) return existing;
    const work = this.runOne(pending);
    this.inFlight.set(pending.sourceId, work);
    try {
      await work;
    } finally {
      if (this.inFlight.get(pending.sourceId) === work) this.inFlight.delete(pending.sourceId);
    }
  }

  private async runOne(pending: SourceModeTransition): Promise<void> {
    try {
      if (pending.toMode === "partitioned") {
        await this.deps.adoption.adoptExclusiveToPartitioned(
          pending.sourceId,
          pending.ownerDeviceId,
        );
      }
      for (;;) {
        const batch = await this.deps.writeGate.adoptSourceModeTransitionBatch(pending.sourceId);
        if (batch.complete) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await this.deps.writeGate.finalizeSourceModeTransition(pending.sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.writeGate.recordSourceModeTransitionFailure(pending.sourceId, message);
      this.scheduleRetry(pending.sourceId);
      throw error;
    }
    await this.publishCompleted(pending.sourceId);
  }

  private async resumePublication(sourceId: SourceId): Promise<void> {
    const existing = this.inFlight.get(sourceId);
    if (existing) return existing;
    const work = this.publishCompleted(sourceId);
    this.inFlight.set(sourceId, work);
    try {
      await work;
    } finally {
      if (this.inFlight.get(sourceId) === work) this.inFlight.delete(sourceId);
    }
  }

  private async publishCompleted(sourceId: SourceId): Promise<void> {
    try {
      await this.deps.onCompleted?.(sourceId);
      await this.deps.writeGate.completeSourceModeTransitionPublication(sourceId);
      this.clearRetry(sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.writeGate.recordSourceModeTransitionPublicationFailure(sourceId, message);
      this.scheduleRetry(sourceId);
      log.warn(`Source mode transition completion callback failed for ${sourceId}: ${message}`);
    }
  }

  private scheduleRetry(sourceId: SourceId): void {
    if (this.disposed || this.retryTimers.has(sourceId)) return;
    const failureCount = (this.failures.get(sourceId) ?? 0) + 1;
    this.failures.set(sourceId, failureCount);
    const base = this.deps.retryBaseMs ?? RETRY_BASE_MS;
    const maximum = this.deps.retryMaxMs ?? RETRY_MAX_MS;
    const delay = Math.min(maximum, base * 2 ** (failureCount - 1));
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceId);
      const pending = getSourceModeTransition(this.deps.db, sourceId);
      if (pending) {
        void this.resumeOne(pending).catch((error: unknown) => {
          log.warn(
            `Source mode transition retry for ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return;
      }
      if (getSourceModeTransitionPublication(this.deps.db, sourceId)) {
        void this.resumePublication(sourceId);
        return;
      }
      this.failures.delete(sourceId);
    }, delay);
    timer.unref();
    this.retryTimers.set(sourceId, timer);
  }

  private clearRetry(sourceId: SourceId): void {
    const timer = this.retryTimers.get(sourceId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sourceId);
    this.failures.delete(sourceId);
  }
}
