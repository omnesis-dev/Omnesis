// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { SourceId } from "@omnesis/types";
import { createLogger } from "@omnesis/core";
import { directReadPort } from "../scheduler/read-port.js";
import { STORAGE_READS, type StorageReads } from "./reads.js";
import { retentionCutoff } from "./retention-policy.js";
import { STORAGE_RETENTION_BATCH_SIZE, type StorageRetentionCandidate } from "./retention-store.js";
import type Database from "better-sqlite3";
import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";
import type { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import type { WriteGate } from "../write-gate.js";
import type { ConfigRevisionFence } from "../config-store.js";

export interface StorageRetentionPolicy {
  sourceId: string;
  maxAgeDays: number;
  /** Immutable creation marker of the source row which authorized the policy. */
  sourceCreatedAt?: number;
}

export interface StorageRetentionResult {
  deleted: number;
  hasMore: boolean;
  cleanupPending?: true;
}

const log = createLogger("gateway:storage");

export interface RetentionPreview {
  token: string;
  sourceId: string;
  before: string;
  expiresAt: string;
  documents: number;
  /** Logical document payload, not a promise of physical disk reclaimed. */
  payloadBytes: number;
  hasMore: boolean;
}

export class StorageRetentionError extends Error {
  constructor(
    public readonly status: 400 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Plan {
  preview: RetentionPreview;
  candidates: StorageRetentionCandidate[];
}

export interface StorageRetentionDeps {
  db: Database.Database;
  writeGate: Pick<WriteGate, "deleteStorageRetentionBatch">;
  sourceWriteEpochFence: SourceWriteEpochFence;
  finishCascade: (cascade: AbsenceCascade) => Promise<void>;
  clock?: () => number;
  reads?: Pick<StorageReads, "storageRetentionCandidates">;
  captureAuthority?: () => ConfigRevisionFence;
}

/** User approval covers one bounded, source-bound, revision-frozen batch. */
export class StorageRetentionService {
  private readonly plans = new Map<string, Plan>();
  private readonly clock: () => number;
  private nextPolicy = 0;
  private readonly reads: Pick<StorageReads, "storageRetentionCandidates">;
  constructor(private readonly deps: StorageRetentionDeps) {
    this.clock = deps.clock ?? Date.now;
    this.reads = deps.reads ?? directReadPort(STORAGE_READS, deps.db);
  }

  async preview(sourceId: string, before: string): Promise<RetentionPreview> {
    SourceId(sourceId);
    const date = new Date(before);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !== before ||
      date.getTime() > this.clock()
    ) {
      throw new StorageRetentionError(
        400,
        "INVALID_RETENTION_CUTOFF",
        "Choose a valid past UTC date.",
      );
    }
    this.expirePlans();
    if (this.plans.size >= 100) {
      throw new StorageRetentionError(
        409,
        "TOO_MANY_RETENTION_PREVIEWS",
        "Finish or wait for an existing preview to expire.",
      );
    }
    const rows = await this.reads.storageRetentionCandidates(sourceId, before);
    this.expirePlans();
    if (this.plans.size >= 100) {
      throw new StorageRetentionError(
        409,
        "TOO_MANY_RETENTION_PREVIEWS",
        "Finish or wait for an existing preview to expire.",
      );
    }
    const candidates = rows.slice(0, STORAGE_RETENTION_BATCH_SIZE);
    const preview: RetentionPreview = {
      token: randomUUID(),
      sourceId,
      before,
      expiresAt: new Date(this.clock() + 10 * 60_000).toISOString(),
      documents: candidates.length,
      payloadBytes: candidates.reduce((sum, row) => sum + row.payload_bytes, 0),
      hasMore: rows.length > STORAGE_RETENTION_BATCH_SIZE,
    };
    this.plans.set(preview.token, { preview, candidates });
    return { ...preview };
  }

  async execute(token: string): Promise<StorageRetentionResult> {
    this.expirePlans();
    const plan = this.plans.get(token);
    if (!plan)
      throw new StorageRetentionError(
        409,
        "RETENTION_PREVIEW_EXPIRED",
        "Create a fresh preview before removing data.",
      );
    // Consume before awaiting: concurrent requests cannot spend an approval twice.
    this.plans.delete(token);
    return this.remove(plan, true);
  }

  /** One source and one batch per tick; an unlimited history never monopolizes the writer. */
  async sweep(
    policyInput: readonly StorageRetentionPolicy[] | (() => readonly StorageRetentionPolicy[]),
  ): Promise<{ deleted: number }> {
    const policies = typeof policyInput === "function" ? policyInput() : policyInput;
    if (policies.length === 0) {
      this.nextPolicy = 0;
      return { deleted: 0 };
    }
    const policy = policies[this.nextPolicy++ % policies.length]!;
    if (
      !Number.isInteger(policy.maxAgeDays) ||
      policy.maxAgeDays <= 0 ||
      policy.maxAgeDays > 36_500
    ) {
      throw new StorageRetentionError(
        400,
        "INVALID_RETENTION_POLICY",
        "Retention must be between 1 and 36500 days.",
      );
    }
    const before = retentionCutoff([policy], policy.sourceId, this.clock())!;
    const preview = await this.preview(policy.sourceId, before);
    const plan = this.plans.get(preview.token)!;
    this.plans.delete(preview.token);
    return this.remove(plan, false, () => {
      const current = typeof policyInput === "function" ? policyInput() : policyInput;
      if (
        !current.some(
          (row) =>
            row.sourceId === policy.sourceId &&
            row.maxAgeDays === policy.maxAgeDays &&
            row.sourceCreatedAt === policy.sourceCreatedAt,
        )
      ) {
        throw new StorageRetentionError(
          409,
          "RETENTION_POLICY_CHANGED",
          "The retention policy changed before cleanup began.",
        );
      }
      if (policy.sourceCreatedAt !== undefined) {
        const source = this.deps.db
          .prepare<[string], { created_at: number }>("SELECT created_at FROM sources WHERE id = ?")
          .get(policy.sourceId);
        if (!source || source.created_at !== policy.sourceCreatedAt) {
          throw new StorageRetentionError(
            409,
            "RETENTION_SOURCE_CHANGED",
            "The source was removed or replaced. Review its retention policy before cleanup.",
          );
        }
      }
    });
  }

  private async remove(
    plan: Plan,
    tombstone: boolean,
    assertAuthority?: () => void,
  ): Promise<StorageRetentionResult> {
    return this.deps.sourceWriteEpochFence.runSourceExclusive(plan.preview.sourceId, async () => {
      assertAuthority?.();
      const result = await this.deps.writeGate.deleteStorageRetentionBatch({
        sourceId: plan.preview.sourceId,
        before: plan.preview.before,
        candidates: plan.candidates,
        tombstone,
        ...(assertAuthority && this.deps.captureAuthority
          ? { authority: this.deps.captureAuthority() }
          : {}),
      });
      if (result.stale)
        throw new StorageRetentionError(
          409,
          "RETENTION_PREVIEW_CHANGED",
          "The selected data changed. Review a fresh preview before removing it.",
        );
      if (result.cascade) {
        try {
          await this.deps.finishCascade(result.cascade);
        } catch (error) {
          log.warn(
            `Storage cleanup remains queued: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { deleted: result.deleted, hasMore: plan.preview.hasMore, cleanupPending: true };
        }
      }
      return { deleted: result.deleted, hasMore: plan.preview.hasMore };
    });
  }

  private expirePlans(): void {
    const now = this.clock();
    for (const [token, plan] of this.plans) {
      if (Date.parse(plan.preview.expiresAt) <= now) this.plans.delete(token);
    }
  }
}
