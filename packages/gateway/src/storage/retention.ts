// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { StorageTrimJobs, type StorageTrimJobWrites } from "./trim-jobs.js";
import type { BoundStorageRetentionPolicy } from "./retention-bindings.js";
import type { StorageTrimJob, StorageTrimPage, StoredStorageTrimJob } from "./trim-job-store.js";
import type Database from "better-sqlite3";
import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";
import type { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import type { ConfigRevisionFence } from "../config-store.js";

export type StorageRetentionPolicy = BoundStorageRetentionPolicy;

export interface StorageRetentionDeps {
  db: Database.Database;
  writeGate: StorageTrimJobWrites;
  sourceWriteEpochFence: SourceWriteEpochFence;
  finishCascade: (cascade: AbsenceCascade) => Promise<void>;
  clock?: () => number;
  reads?: { storageTrimPage?: (job: StoredStorageTrimJob) => Promise<StorageTrimPage> };
  captureAuthority?: () => ConfigRevisionFence;
}

/** Manual and rolling cleanup share durable commands and bounded background processing. */
export class StorageRetentionService {
  private readonly trimJobs: StorageTrimJobs;
  constructor(deps: StorageRetentionDeps) {
    this.trimJobs = new StorageTrimJobs({
      db: deps.db,
      writes: deps.writeGate,
      readPage: deps.reads?.storageTrimPage,
      sourceWriteEpochFence: deps.sourceWriteEpochFence,
      finishCascade: deps.finishCascade,
      captureAuthority: deps.captureAuthority,
      clock: deps.clock,
    });
  }

  startTrim(sourceId: string, before: string): Promise<StorageTrimJob> {
    return this.trimJobs.startTrim(sourceId, before);
  }

  jobs(): StorageTrimJob[] {
    return this.trimJobs.jobs();
  }

  job(id: string): StorageTrimJob | null {
    return this.trimJobs.job(id);
  }

  sweep(
    policyInput: readonly StorageRetentionPolicy[] | (() => readonly StorageRetentionPolicy[]),
  ): Promise<{ deleted: number; hasMore: boolean }> {
    return this.trimJobs.sweep(() =>
      typeof policyInput === "function" ? policyInput() : policyInput,
    );
  }
}
