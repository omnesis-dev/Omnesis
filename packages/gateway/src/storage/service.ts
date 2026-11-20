// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SourceId } from "@omnesis/types";
import { applyMergePatch, type GatewayStoragePolicySettings } from "@omnesis/config";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../http/errors.js";
import {
  captureStorageRetentionBindingInputs,
  readBoundStorageRetentionPolicies,
  readStorageSourceIncarnation,
} from "./retention-bindings.js";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";
import type { StorageRetentionService } from "./retention.js";
import type { ConfigStore } from "../config-store.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { StoragePressureManager } from "./pressure.js";
import type { StorageAccountingStatus } from "./accounting-status.js";

export interface StorageServiceDeps {
  pressure: StoragePressureManager;
  physical: () => DiskUsageSnapshot | null;
  logical: () => import("./accounting.js").StorageAccounting | null;
  index: () => import("./index-accounting.js").IndexStorageAccounting | null;
  refresh: () => Promise<void>;
  refreshIfStale?: () => void;
  accountingStatus?: () => StorageAccountingStatus;
  configStore?: ConfigStore;
  retention: StorageRetentionService;
  sourceExists: (sourceId: string) => boolean;
  db: Database.Database;
  writeGate: Pick<WriteGate, "reconcileStorageRetentionBindings" | "bindStorageRetentionPolicy">;
  sourceWriteEpochFence: import("../source-write-epoch-fence.js").SourceWriteEpochFence;
}

const log = createLogger("gateway:storage");

/** Storage configuration and reclamation share the gateway's existing authority boundaries. */
export class StorageService {
  private policyTail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  constructor(private readonly deps: StorageServiceDeps) {
    const legacy = deps.configStore?.takeLegacyStorageRetentionBindings() ?? [];
    this.ready = this.reconcileBindings(legacy);
    deps.configStore?.onChange(async (before, after, paths) => {
      if (!paths.some((path) => path === "/gateway" || path.startsWith("/gateway/storage"))) return;
      const previous = new Map(
        before.gateway?.storage?.retention?.map((policy) => [policy.sourceId, policy.maxAgeDays]),
      );
      const current = new Map(
        after.gateway?.storage?.retention?.map((policy) => [policy.sourceId, policy.maxAgeDays]),
      );
      const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(
        (id) => previous.get(id) !== current.get(id),
      );
      await this.reconcileBindings(undefined, changed);
    });
  }

  private policies() {
    return this.deps.configStore?.get().gateway?.storage?.retention ?? [];
  }

  private async reconcileBindings(
    legacy: Parameters<
      typeof captureStorageRetentionBindingInputs
    >[2] = this.deps.configStore?.takeLegacyStorageRetentionBindings() ?? [],
    renewSourceIds: string[] = [],
  ) {
    const authority = this.deps.configStore?.captureRevisionFence();
    const policies = captureStorageRetentionBindingInputs(this.deps.db, this.policies(), legacy);
    const result = await this.deps.writeGate.reconcileStorageRetentionBindings({
      policies,
      authority,
      renewSourceIds,
    });
    if (!result.stale && authority && legacy.length) {
      // Config listeners run under the config mutex. Queue normalization without
      // awaiting that mutex here; the binding is already durable in SQLite.
      void this.deps.configStore
        ?.finishLegacyStorageRetentionUpgrade(authority)
        .catch((error: unknown) => {
          log.warn(
            `Storage settings normalization failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  snapshot() {
    this.deps.refreshIfStale?.();
    const pressure = this.deps.pressure.snapshot();
    return {
      physical: this.deps.physical(),
      logical: this.deps.logical(),
      index: this.deps.index(),
      pressure,
      policy: pressure.policy,
      retention: readBoundStorageRetentionPolicies(this.deps.db, this.policies()).map(
        ({ sourceId, maxAgeDays }) => ({ sourceId, maxAgeDays }),
      ),
      trimJobs: this.deps.retention.jobs(),
      accounting: this.deps.accountingStatus?.() ?? null,
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
    await this.ready;
    SourceId(sourceId);
    if (maxAgeDays !== null && !this.deps.sourceExists(sourceId))
      throw new NotFoundError("Source no longer exists");
    return this.serializePolicy(() =>
      this.deps.sourceWriteEpochFence.runSourceExclusive(sourceId, async () => {
        const sourceIncarnation = readStorageSourceIncarnation(this.deps.db, sourceId);
        if (maxAgeDays !== null && sourceIncarnation === null)
          throw new NotFoundError("Source no longer exists");
        if (!this.deps.configStore)
          throw new ServiceUnavailableError("Storage settings are unavailable");
        // Read-modify-write shares the config store's mutex with raw config
        // edits as well as this service's targeted source-policy mutations.
        const result = await this.deps.configStore.update((current) => {
          const retention = (current.gateway?.storage?.retention ?? []).filter(
            (policy) => policy.sourceId !== sourceId,
          );
          if (maxAgeDays !== null) retention.push({ sourceId, maxAgeDays });
          return applyMergePatch(current, { gateway: { storage: { retention } } });
        });
        if (!result.ok) throw new ValidationError("Invalid storage settings", result.errors);
        if (maxAgeDays !== null) {
          if (
            !this.policies().some(
              (policy) => policy.sourceId === sourceId && policy.maxAgeDays === maxAgeDays,
            )
          )
            throw new ConflictError("Retention settings changed; try again");
          const bound = await this.deps.writeGate.bindStorageRetentionPolicy({
            sourceId,
            maxAgeDays,
            sourceIncarnation: sourceIncarnation!,
            authority: this.deps.configStore.captureRevisionFence(),
          });
          if (bound.stale)
            throw new ConflictError("Source or retention settings changed; try again");
        }
        return this.snapshot();
      }),
    );
  }

  async startTrim(sourceId: string, before: string) {
    await this.ready;
    if (!this.deps.sourceExists(sourceId)) throw new NotFoundError("Source no longer exists");
    return this.deps.retention.startTrim(sourceId, before);
  }

  async sweep() {
    await this.ready;
    return this.deps.retention.sweep(() =>
      readBoundStorageRetentionPolicies(this.deps.db, this.policies()),
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
