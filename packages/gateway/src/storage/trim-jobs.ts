// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SourceId } from "@omnesis/types";
import { createLogger } from "@omnesis/core";
import { BadRequestError, ConflictError, NotFoundError } from "../http/errors.js";
import {
  readStorageSourceIncarnation,
  type BoundStorageRetentionPolicy,
} from "./retention-bindings.js";
import {
  listStorageTrimJobs,
  readStorageTrimJob,
  readStorageTrimPendingCascade,
  readStorageTrimPage,
  type FailStorageTrimJob,
  type StartStorageTrimJob,
  type ApplyStorageTrimPage,
  type AppliedStorageTrimPage,
  type StoredStorageTrimJob,
  type StorageTrimJob,
  type StorageTrimPage,
} from "./trim-job-store.js";
import type Database from "better-sqlite3";
import type { ConfigRevisionFence } from "../config-store.js";
import type { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";

const log = createLogger("gateway:storage:trim");
export interface StorageTrimJobWrites {
  startStorageTrimJob(input: StartStorageTrimJob): Promise<StoredStorageTrimJob | null>;
  applyStorageTrimPage(input: ApplyStorageTrimPage): Promise<AppliedStorageTrimPage>;
  failStorageTrimJob(input: FailStorageTrimJob): Promise<StoredStorageTrimJob | null>;
}
export interface StorageTrimJobsDeps {
  db: Database.Database;
  writes: StorageTrimJobWrites;
  readPage?: (job: StoredStorageTrimJob) => Promise<StorageTrimPage>;
  sourceWriteEpochFence: SourceWriteEpochFence;
  finishCascade: (cascade: AbsenceCascade) => Promise<void>;
  captureAuthority?: () => ConfigRevisionFence;
  clock?: () => number;
}

function publicJob(job: StoredStorageTrimJob): StorageTrimJob {
  const {
    id,
    kind,
    sourceId,
    before,
    state,
    deleted,
    examinedDocuments,
    skippedDocuments,
    cleanupPending,
    createdAt,
    updatedAt,
    completedAt,
    error,
  } = job;
  return {
    id,
    kind,
    sourceId,
    before,
    state,
    deleted,
    examinedDocuments,
    skippedDocuments,
    cleanupPending,
    createdAt,
    updatedAt,
    completedAt,
    error,
  };
}

/** One cursor job and one bounded shared processing path for manual and rolling cleanup. */
export class StorageTrimJobs {
  private readonly clock: () => number;
  private manualTurn = true;
  private nextPolicy = 0;
  private lastManualId = "";
  constructor(private readonly deps: StorageTrimJobsDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  jobs(): StorageTrimJob[] {
    return listStorageTrimJobs(this.deps.db, true).map(publicJob);
  }

  async startTrim(sourceId: string, before: string): Promise<StorageTrimJob> {
    SourceId(sourceId);
    const date = new Date(before);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !== before ||
      date.getTime() > this.clock()
    ) {
      throw new BadRequestError("Choose a valid past UTC cutoff before starting a trim.");
    }
    return this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, async () => {
      const incarnation = readStorageSourceIncarnation(this.deps.db, sourceId);
      if (!incarnation) throw new NotFoundError("Source no longer exists");
      const active = listStorageTrimJobs(this.deps.db).find(
        (job) =>
          job.kind === "manual" &&
          job.sourceId === sourceId &&
          job.sourceIncarnation === incarnation &&
          (job.state === "queued" || job.state === "running"),
      );
      if (active && active.before !== before)
        throw new ConflictError("A trim is already running for this source.");
      const job = await this.deps.writes.startStorageTrimJob({
        sourceId,
        before,
        kind: "manual",
        sourceIncarnation: incarnation,
        now: this.clock(),
      });
      if (!job) throw new ConflictError("Source changed before the trim could start. Try again.");
      return publicJob(job);
    });
  }

  async sweep(
    getPolicies: () => readonly BoundStorageRetentionPolicy[],
  ): Promise<{ deleted: number; hasMore: boolean }> {
    const active = listStorageTrimJobs(this.deps.db);
    const manuals = active
      .filter((job) => job.kind === "manual" && (job.state === "queued" || job.state === "running"))
      .sort((a, b) => a.id.localeCompare(b.id));
    const manual = manuals.find((job) => job.id > this.lastManualId) ?? manuals[0];
    const policies = getPolicies();
    if (manual && (this.manualTurn || policies.length === 0)) {
      this.manualTurn = false;
      this.lastManualId = manual.id;
      return this.process(manual);
    }
    this.manualTurn = true;
    if (!policies.length) return { deleted: 0, hasMore: false };
    const policy = policies[this.nextPolicy++ % policies.length]!;
    const before = new Date(this.clock() - policy.maxAgeDays * 86_400_000).toISOString();
    return this.deps.sourceWriteEpochFence.runSourceExclusive(policy.sourceId, async () => {
      if (!this.currentPolicy(getPolicies, policy)) return { deleted: 0, hasMore: !!manual };
      const job = await this.deps.writes.startStorageTrimJob({
        kind: "rolling",
        sourceId: policy.sourceId,
        before,
        sourceIncarnation: policy.sourceIncarnation,
        policy,
        now: this.clock(),
        authority: this.deps.captureAuthority?.(),
      });
      if (!job || job.state === "completed" || job.state === "failed" || job.state === "cancelled")
        return { deleted: 0, hasMore: !!manual };
      return this.processUnfenced(job, () => this.currentPolicy(getPolicies, policy));
    });
  }

  private currentPolicy(
    getPolicies: () => readonly BoundStorageRetentionPolicy[],
    policy: BoundStorageRetentionPolicy,
  ): boolean {
    return getPolicies().some(
      (current) =>
        current.sourceId === policy.sourceId &&
        current.maxAgeDays === policy.maxAgeDays &&
        current.sourceIncarnation === policy.sourceIncarnation &&
        current.bindingId === policy.bindingId,
    );
  }

  private process(job: StoredStorageTrimJob): Promise<{ deleted: number; hasMore: boolean }> {
    return this.deps.sourceWriteEpochFence.runSourceExclusive(job.sourceId, () =>
      this.processUnfenced(job),
    );
  }

  private async processUnfenced(
    job: StoredStorageTrimJob,
    assertPolicy?: () => boolean,
  ): Promise<{ deleted: number; hasMore: boolean }> {
    const pending = readStorageTrimPendingCascade(this.deps.db, job.id);
    if (pending) {
      try {
        await this.deps.finishCascade(pending);
      } catch {
        return { deleted: 0, hasMore: false };
      }
      return { deleted: 0, hasMore: true };
    }
    let result: AppliedStorageTrimPage;
    try {
      const page = await (this.deps.readPage
        ? this.deps.readPage(job)
        : Promise.resolve(readStorageTrimPage(this.deps.db, job)));
      if (assertPolicy && !assertPolicy()) return { deleted: 0, hasMore: true };
      result = await this.deps.writes.applyStorageTrimPage({
        jobId: job.id,
        revision: job.revision,
        page,
        now: this.clock(),
        ...(assertPolicy && this.deps.captureAuthority
          ? { authority: this.deps.captureAuthority() }
          : {}),
      });
    } catch {
      await this.deps.writes.failStorageTrimJob({
        jobId: job.id,
        revision: job.revision,
        now: this.clock(),
      });
      log.warn(`Storage trim could not continue; its status records the failure.`);
      return { deleted: 0, hasMore: false };
    }
    if (result.cascade) {
      try {
        await this.deps.finishCascade(result.cascade);
      } catch (error) {
        log.warn(
          `Storage trim index cleanup remains queued: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const current = result.job ? readStorageTrimJob(this.deps.db, result.job.id) : null;
    return {
      deleted: result.deleted,
      hasMore:
        !current?.cleanupPending && (current?.state === "queued" || current?.state === "running"),
    };
  }
}
