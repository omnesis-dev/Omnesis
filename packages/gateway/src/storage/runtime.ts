// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { measureDiskUsage, type DiskUsageLayout } from "../disk-usage.js";
import { StoragePressureManager, resolveStoragePolicy } from "./pressure.js";
import { measureStorageVolumes } from "./volumes.js";
import { measureStorageAccounting, type StorageAccounting } from "./accounting.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { ConfigStore } from "../config-store.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask } from "../scheduler/types.js";
import type { StorageReads } from "./reads.js";
import type { IndexStorageAccounting } from "./index-accounting.js";
import type { StorageService } from "./service.js";

interface StorageIndexer {
  setStoragePressure(blocked: boolean, validUntil: number): void;
  storageAccounting(): Promise<IndexStorageAccounting>;
}
export interface StorageRuntimeDeps {
  layout: DiskUsageLayout;
  configStore: ConfigStore;
  scheduler: Scheduler;
  reads: StorageReads;
  getMinFreeDiskMb: () => number;
  getIndexer: () => StorageIndexer | null;
  setStoragePressure: (blocked: boolean, validUntil: number) => void;
}

/**
 * The gateway storage manager's composition boundary. Physical capacity,
 * logical accounting and authorized retention have independent jobs: a slow
 * corpus aggregate cannot delay admission refresh or starve reclamation.
 */
export class StorageRuntime {
  readonly pressure: StoragePressureManager;
  physical: DiskUsageSnapshot | null = null;
  logical: StorageAccounting | null = null;
  index: IndexStorageAccounting | null = null;
  service: StorageService | undefined;
  private accountingInFlight: Promise<void> | null = null;

  constructor(private readonly deps: StorageRuntimeDeps) {
    this.pressure = new StoragePressureManager({
      getPolicy: () =>
        resolveStoragePolicy(deps.configStore.get().gateway?.storage, deps.getMinFreeDiskMb()),
      measure: async () => {
        const footprint = await measureDiskUsage(deps.layout, () => new Date(), { strict: true });
        const volumes = await measureStorageVolumes(Object.values(deps.layout));
        this.physical = footprint;
        return {
          usageBytes: footprint.totalBytes,
          measuredAt: Date.parse(footprint.measuredAt),
          volumes,
        };
      },
    });
  }

  start(): void {
    const capacity: PeriodicTask<undefined, void> = {
      name: "storage.capacity.tick",
      runner: "main",
      priority: "realtime",
      periodMs: 1_000,
      initialArgs: undefined,
      run: async () => {
        const interval = this.pressure.snapshot().policy.measurementIntervalMs;
        const last = this.pressure.snapshot().measuredAt;
        if (last === null || Date.now() - last >= interval) await this.pressure.refresh();
        this.publishPressure();
        return { kind: "done", value: undefined };
      },
    };
    const accounting: PeriodicTask<undefined, void> = {
      name: "storage.accounting.tick",
      runner: "main",
      priority: "background",
      periodMs: 10 * 60_000,
      initialArgs: undefined,
      run: async () => {
        await this.refreshAccounting();
        return { kind: "done", value: undefined };
      },
    };
    const retention: PeriodicTask<undefined, void> = {
      name: "storage.retention.tick",
      runner: "main",
      priority: "background",
      periodMs: 5_000,
      initialArgs: undefined,
      run: async () => {
        await this.service?.sweep();
        return { kind: "done", value: undefined };
      },
    };
    this.deps.scheduler.schedule(capacity);
    this.deps.scheduler.schedule(accounting);
    this.deps.scheduler.schedule(retention);
    void this.pressure.refresh().then(() => this.publishPressure());
    this.deps.configStore.onChange((_before, _after, paths) => {
      if (paths.some((path) => path === "/gateway" || path.startsWith("/gateway/"))) {
        this.publishPressure();
        this.deps.scheduler.kickPeriodic(capacity.name);
      }
    });
  }

  /** An explicit portal refresh shares ongoing accounting rather than starting a second scan. */
  async refresh(): Promise<void> {
    await Promise.all([
      this.pressure.refresh().then(() => this.publishPressure()),
      this.refreshAccounting(),
    ]);
  }

  private refreshAccounting(): Promise<void> {
    this.accountingInFlight ??= (async () => {
      this.logical = await measureStorageAccounting(this.deps.reads);
      const indexer = this.deps.getIndexer();
      if (indexer) this.index = await indexer.storageAccounting();
    })().finally(() => {
      this.accountingInFlight = null;
    });
    return this.accountingInFlight;
  }

  private publishPressure(): void {
    const pressure = this.pressure.snapshot();
    this.deps.setStoragePressure(
      pressure.state === "blocked" || pressure.state === "unknown",
      pressure.validUntil,
    );
  }
}
