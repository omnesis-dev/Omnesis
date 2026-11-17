// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SourceId } from "@omnesis/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../http/errors.js";
import { StorageRetentionError, type StorageRetentionService } from "./retention.js";
import type { ConfigStore } from "../config-store.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { StoragePressureManager } from "./pressure.js";
import type { GatewayStoragePolicySettings } from "@omnesis/config";

export interface StorageServiceDeps {
  pressure: StoragePressureManager;
  physical: () => DiskUsageSnapshot | null;
  logical: () => import("./accounting.js").StorageAccounting | null;
  index: () => import("./index-accounting.js").IndexStorageAccounting | null;
  refresh: () => Promise<void>;
  configStore?: ConfigStore;
  retention: StorageRetentionService;
  sourceExists: (sourceId: string) => boolean;
  sourceCreatedAt: (sourceId: string) => number | null;
  sourceWriteEpochFence: import("../source-write-epoch-fence.js").SourceWriteEpochFence;
}

/** Storage configuration and reclamation share the gateway's existing authority boundaries. */
export class StorageService {
  private policyTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: StorageServiceDeps) {}

  snapshot() {
    const pressure = this.deps.pressure.snapshot();
    return {
      physical: this.deps.physical(),
      logical: this.deps.logical(),
      index: this.deps.index(),
      pressure,
      policy: pressure.policy,
      retention: this.deps.configStore?.get().gateway?.storage?.retention ?? [],
    };
  }

  async refresh() {
    await this.deps.refresh();
    return this.snapshot();
  }

  async setPolicy(policy: Omit<GatewayStoragePolicySettings, "retention">) {
    return this.serializePolicy(async () => {
      await this.patch({ gateway: { storage: policy } });
      await this.deps.pressure.refresh();
      return this.snapshot();
    });
  }

  async setRetention(sourceId: string, maxAgeDays: number | null) {
    SourceId(sourceId);
    if (maxAgeDays !== null && !this.deps.sourceExists(sourceId))
      throw new NotFoundError("Source no longer exists");
    return this.serializePolicy(() =>
      this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, async () => {
        const sourceCreatedAt = this.deps.sourceCreatedAt(sourceId);
        if (maxAgeDays !== null && sourceCreatedAt === null)
          throw new NotFoundError("Source no longer exists");
        const retention = (this.deps.configStore?.get().gateway?.storage?.retention ?? []).filter(
          (policy) => policy.sourceId !== sourceId,
        );
        if (maxAgeDays !== null)
          retention.push({ sourceId, maxAgeDays, sourceCreatedAt: sourceCreatedAt! });
        await this.patch({ gateway: { storage: { retention } } });
        return this.snapshot();
      }),
    );
  }

  async preview(sourceId: string, before: string) {
    if (!this.deps.sourceExists(sourceId)) throw new NotFoundError("Source no longer exists");
    try {
      return await this.deps.retention.preview(sourceId, before);
    } catch (error) {
      throw mappedRetentionError(error);
    }
  }

  async trim(token: string) {
    try {
      const result = await this.deps.retention.execute(token);
      // Refresh asynchronously: deletion frees reusable database pages, which
      // need not reduce the database file's footprint on the filesystem.
      void this.deps.pressure.refresh();
      return result;
    } catch (error) {
      throw mappedRetentionError(error);
    }
  }

  async sweep() {
    return this.deps.retention.sweep(() =>
      (this.deps.configStore?.get().gateway?.storage?.retention ?? []).filter((policy) => {
        const incarnation = this.deps.sourceCreatedAt(policy.sourceId);
        return (
          incarnation !== null &&
          (policy.sourceCreatedAt === undefined || incarnation === policy.sourceCreatedAt)
        );
      }),
    );
  }

  private async patch(patch: unknown): Promise<void> {
    if (!this.deps.configStore)
      throw new ServiceUnavailableError("Storage settings are unavailable");
    const result = await this.deps.configStore.patch(patch);
    if (!result.ok) throw new ValidationError("Invalid storage settings", result.errors);
  }

  private serializePolicy<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.policyTail.then(operation);
    this.policyTail = result.catch(() => undefined);
    return result;
  }
}

function mappedRetentionError(error: unknown): unknown {
  if (!(error instanceof StorageRetentionError)) return error;
  return error.status === 409
    ? new ConflictError(error.message)
    : new BadRequestError(error.message);
}
