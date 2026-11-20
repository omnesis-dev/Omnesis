// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { measureDiskUsage, type DiskUsageLayout } from "../disk-usage.js";
import { StoragePressureManager, resolveStoragePolicy } from "./pressure.js";
import { measureStorageVolumes } from "./volumes.js";
import {
  measureStorageAccounting,
  type StorageAccounting,
  type StorageAccountingReads,
} from "./accounting.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";
import type { ConfigStore } from "../config-store.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask } from "../scheduler/types.js";
import type { IndexStorageAccounting } from "./index-accounting.js";
import type { StorageService } from "./service.js";
import type { StorageAccountingStatus, StorageMeasurementStatus } from "./accounting-status.js";
import type {
  StorageAllocationReader,
  AllocationStore,
  StorageAllocationSnapshot,
} from "./allocation-reader.js";
const log = createLogger("gateway:storage");
const ACCOUNTING_FRESH_MS = 30_000;
export interface StorageRuntimeDeps {
  layout: DiskUsageLayout;
  configStore: ConfigStore;
  scheduler: Scheduler;
  reads: StorageAccountingReads;
  getMinFreeDiskMb: () => number;
  measureIndex: () => Promise<IndexStorageAccounting | null>;
  allocations?: Pick<StorageAllocationReader, "measure" | "dispose">;
  canMeasureAllocations?: () => boolean;
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
  private accountingAttemptAt = 0;
  private accountingError: string | null = null;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private allocationInFlight: Promise<void> | null = null;
  private allocationAttemptAt = 0;
  private allocationForceRequested = false;
  private readonly allocationSnapshots = new Map<AllocationStore, StorageAllocationSnapshot>();
  private allocationStatus: NonNullable<StorageAccountingStatus["allocations"]> = {
    state: "pending",
    measuredAt: null,
    error: null,
  };
  private logicalStatus: StorageMeasurementStatus = {
    state: "pending",
    measuredAt: null,
    error: null,
  };
  private indexStatus: StorageMeasurementStatus = {
    state: "pending",
    measuredAt: null,
    error: null,
  };

  accountingStatus(): StorageAccountingStatus {
    return {
      refreshing: this.accountingInFlight !== null || this.allocationInFlight !== null,
      measuredAt: this.logical?.measuredAt ?? null,
      error: this.accountingError,
      logical: { ...this.logicalStatus },
      index: { ...this.indexStatus },
      ...(this.deps.allocations ? { allocations: { ...this.allocationStatus } } : {}),
    };
  }

  /** Portal polling reads cached measurements and only schedules a coalesced stale refresh. */
  refreshIfStale(): void {
    if (
      this.disposed ||
      this.accountingInFlight ||
      Date.now() - this.accountingAttemptAt < ACCOUNTING_FRESH_MS
    )
      return;
    void this.refreshAccounting().catch((error: unknown) => {
      if (this.disposed) return;
      log.warn(
        `Storage measurement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

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
    if (this.disposed) return;
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
      periodMs: 1_000,
      initialArgs: undefined,
      run: async () => {
        const result = await this.service?.sweep();
        if (result?.hasMore) this.deps.scheduler.kickPeriodic("storage.retention.tick");
        return { kind: "done", value: undefined };
      },
    };
    const allocations: PeriodicTask<undefined, void> = {
      name: "storage.allocations.tick",
      runner: "main",
      priority: "background",
      periodMs: 30_000,
      initialArgs: undefined,
      run: async () => {
        await this.refreshAllocations();
        return { kind: "done", value: undefined };
      },
    };
    this.deps.scheduler.schedule(capacity);
    this.deps.scheduler.schedule(accounting);
    this.deps.scheduler.schedule(retention);
    if (this.deps.allocations) this.deps.scheduler.schedule(allocations);
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
    if (this.disposed) return;
    if (this.deps.allocations && !this.allocationInFlight) this.allocationForceRequested = true;
    try {
      await Promise.all([
        this.pressure.refresh().then(() => this.publishPressure()),
        this.refreshAccounting(),
      ]);
    } finally {
      // A retry starts optional physical detail, but never waits for its long scan.
      void this.refreshAllocations();
    }
  }

  private refreshAccounting(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.accountingInFlight) return this.accountingInFlight;
    this.accountingAttemptAt = Date.now();
    this.logicalStatus = { ...this.logicalStatus, state: "refreshing", error: null };
    this.indexStatus = { ...this.indexStatus, state: "refreshing", error: null };
    this.accountingError = null;
    this.accountingInFlight = (async () => {
      const results = await Promise.allSettled([
        measureStorageAccounting(this.deps.reads).then(
          (logical) => {
            if (this.disposed) return;
            // A separate physical allocation scan may already have supplied tables.
            logical.database.tables ??=
              this.allocationSnapshots.get("documents")?.tables ??
              this.logical?.database.tables ??
              null;
            this.logical = logical;
            this.logicalStatus = { state: "ready", measuredAt: logical.measuredAt, error: null };
          },
          (error: unknown) => {
            if (this.disposed) throw error;
            this.logicalStatus = {
              ...this.logicalStatus,
              state: "failed",
              error: "Document storage could not be measured. Retry to update it.",
            };
            throw error;
          },
        ),
        Promise.resolve()
          .then(() => this.deps.measureIndex())
          .then(
            (index) => {
              if (this.disposed) return;
              if (index) {
                index.tables ??=
                  this.allocationSnapshots.get("index")?.tables ?? this.index?.tables ?? null;
                index.lexicalBytes ??=
                  index.tables?.reduce(
                    (bytes, table) =>
                      bytes + (table.name.startsWith("chunks_fts") ? table.bytes : 0),
                    0,
                  ) ??
                  this.index?.lexicalBytes ??
                  null;
                this.index = index;
              }
              this.indexStatus = {
                state: index ? "ready" : "pending",
                measuredAt: this.index?.measuredAt ?? null,
                error: null,
              };
            },
            (error: unknown) => {
              if (this.disposed) throw error;
              this.indexStatus = {
                ...this.indexStatus,
                state: "failed",
                error: "Search-index storage could not be measured. Retry to update it.",
              };
              throw error;
            },
          ),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })()
      .catch((error: unknown) => {
        if (!this.disposed)
          this.accountingError =
            "Storage measurement could not be updated. Retry to measure again.";
        throw error;
      })
      .finally(() => {
        this.accountingInFlight = null;
        this.accountingAttemptAt = Date.now();
        if (this.allocationForceRequested) void this.refreshAllocations();
      });
    return this.accountingInFlight;
  }

  /** Allocation detail owns its own bounded reader and never gates source totals. */
  private refreshAllocations(): Promise<void> {
    if (this.allocationInFlight) return this.allocationInFlight;
    const interval = this.allocationStatus.state === "ready" ? 10 * 60_000 : 60_000;
    if (
      this.disposed ||
      !this.deps.allocations ||
      this.accountingInFlight ||
      this.accountingAttemptAt === 0 ||
      this.deps.canMeasureAllocations?.() === false ||
      (!this.allocationForceRequested &&
        this.allocationAttemptAt !== 0 &&
        Date.now() - this.allocationAttemptAt < interval)
    )
      return Promise.resolve();
    const force = this.allocationForceRequested;
    this.allocationForceRequested = false;
    this.allocationStatus = { ...this.allocationStatus, state: "refreshing", error: null };
    this.allocationInFlight = (async () => {
      let complete = true;
      for (const store of ["documents", "index"] as const) {
        const snapshot = await this.deps.allocations!.measure(store, { force });
        if (this.disposed) return;
        this.allocationSnapshots.set(store, snapshot);
        // Partial current trees are never substituted for a complete inventory.
        if (snapshot.tables && snapshot.measuredAt) {
          if (store === "documents" && this.logical) {
            this.logical = {
              ...this.logical,
              database: { ...this.logical.database, tables: snapshot.tables },
            };
          }
          if (store === "index" && this.index) {
            this.index = {
              ...this.index,
              tables: snapshot.tables,
              lexicalBytes: snapshot.tables.reduce(
                (bytes, table) => bytes + (table.name.startsWith("chunks_fts") ? table.bytes : 0),
                0,
              ),
            };
          }
        }
        complete &&=
          snapshot.state === "ready" && snapshot.tables !== null && snapshot.measuredAt !== null;
      }
      if (this.disposed) return;
      this.allocationStatus = complete
        ? {
            state: "ready",
            measuredAt: this.allocationSnapshots.get("documents")!.measuredAt,
            error: null,
          }
        : {
            ...this.allocationStatus,
            state: "failed",
            error: "File allocation details are incomplete. Retry to update them.",
          };
    })()
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.allocationStatus = {
          ...this.allocationStatus,
          state: "failed",
          error: "File allocation details could not be measured. Retry to update them.",
        };
        log.warn(
          `Storage allocation measurement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.allocationInFlight = null;
        this.allocationAttemptAt = Date.now();
      });
    return this.allocationInFlight;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return (this.closing ??= Promise.resolve().then(() => this.deps.allocations?.dispose()));
  }

  /** Progress is distinct from a completed inventory and never changes source totals. */
  observeAllocation(store: AllocationStore, snapshot: StorageAllocationSnapshot): void {
    if (this.disposed || this.allocationInFlight === null) return;
    this.allocationStatus = {
      ...this.allocationStatus,
      progress: {
        store,
        scannedPages: snapshot.scannedPages,
        completedTables: snapshot.completed.length,
        ...(snapshot.scannedBytes !== undefined ? { scannedBytes: snapshot.scannedBytes } : {}),
      },
    };
  }

  private publishPressure(): void {
    if (this.disposed) return;
    const pressure = this.pressure.snapshot();
    this.deps.setStoragePressure(
      pressure.state === "blocked" || pressure.state === "unknown",
      pressure.validUntil,
    );
  }
}
