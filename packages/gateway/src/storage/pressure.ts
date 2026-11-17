// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { InsufficientStorageError } from "../http/errors.js";
import type { GatewayStoragePolicySettings } from "@omnesis/config";

export interface StoragePolicy {
  maxBytes: number | null;
  maxDiskUsedPercent: number;
  resumeMarginPercent: number;
  measurementMaxAgeMs: number;
  minFreeBytes: number;
}

export function resolveStoragePolicy(
  settings?: GatewayStoragePolicySettings,
  minFreeDiskMb = 500,
): StoragePolicy {
  return {
    maxBytes: settings?.maxBytes ?? null,
    maxDiskUsedPercent: settings?.maxDiskUsedPercent ?? 95,
    resumeMarginPercent: settings?.resumeMarginPercent ?? 2,
    measurementMaxAgeMs: settings?.measurementMaxAgeMs ?? 120_000,
    minFreeBytes: minFreeDiskMb * 1024 * 1024,
  };
}

/** Volumes are deduplicated by filesystem identity by the measurement adapter. */
export interface StorageVolume {
  id: string;
  totalBytes: number;
  availableBytes: number;
}

export interface StorageMeasurement {
  usageBytes: number;
  /** Time the footprint inventory was completed, not the time it was read from cache. */
  measuredAt: number;
  volumes: StorageVolume[];
}

export type StoragePressureState = "normal" | "warning" | "blocked" | "unknown";
export type StoragePressureReason = "quota" | "disk-used" | "disk-reserve" | "measurement";

export interface StoragePressureSnapshot {
  state: StoragePressureState;
  reasons: StoragePressureReason[];
  measuredAt: number | null;
  usageBytes: number | null;
  volumes: StorageVolume[];
  policy: StoragePolicy;
  /** A worker must fail closed after this deadline if it stops hearing from the manager. */
  validUntil: number;
}

export interface StoragePressureOptions {
  getPolicy: () => StoragePolicy;
  measure: () => Promise<StorageMeasurement>;
  now?: () => number;
}

/**
 * Capacity admission is independent from retention. Crossing a limit parks new
 * growth and never deletes anything. Reads and explicit reclamation stay usable.
 * A single-flight asynchronous inventory keeps walks off the request path;
 * snapshots are cheap decisions against the latest completed inventory.
 */
export class StoragePressureManager {
  private measurement: StorageMeasurement | null = null;
  private inFlight: Promise<void> | null = null;
  private measurementFailed = false;
  private blockedReasons = new Set<StoragePressureReason>();
  private readonly now: () => number;

  constructor(private readonly options: StoragePressureOptions) {
    this.now = options.now ?? Date.now;
  }

  refresh(): Promise<void> {
    this.inFlight ??= Promise.resolve()
      .then(this.options.measure)
      .then((measurement) => {
        if (!validMeasurement(measurement, this.now()))
          throw new Error("Invalid capacity measurement");
        this.measurement = {
          ...measurement,
          volumes: measurement.volumes.map((volume) => ({ ...volume })),
        };
        this.measurementFailed = false;
        this.snapshot();
      })
      .catch(() => {
        // An unreadable filesystem is unknown, never zero bytes or infinite capacity.
        this.measurementFailed = true;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  snapshot(): StoragePressureSnapshot {
    const policy = this.options.getPolicy();
    const measurement = this.measurement;
    const now = this.now();
    const validUntil = measurement ? measurement.measuredAt + policy.measurementMaxAgeMs : 0;
    const base = {
      measuredAt: measurement?.measuredAt ?? null,
      usageBytes: measurement?.usageBytes ?? null,
      volumes: measurement?.volumes.map((volume) => ({ ...volume })) ?? [],
      policy,
      validUntil,
    };
    if (this.measurementFailed || !measurement || now >= validUntil) {
      return { ...base, state: "unknown", reasons: ["measurement"] };
    }

    const blocked = new Set<StoragePressureReason>();
    const warnings = new Set<StoragePressureReason>();
    const fraction = policy.resumeMarginPercent / 100;
    if (policy.maxBytes !== null) {
      const limit = policy.maxBytes * (this.blockedReasons.has("quota") ? 1 - fraction : 1);
      if (measurement.usageBytes >= limit) blocked.add("quota");
      else if (measurement.usageBytes >= policy.maxBytes * 0.9) warnings.add("quota");
    }
    for (const volume of measurement.volumes) {
      const usedPercent = (1 - volume.availableBytes / volume.totalBytes) * 100;
      const diskLimit =
        policy.maxDiskUsedPercent -
        (this.blockedReasons.has("disk-used") ? policy.resumeMarginPercent : 0);
      if (usedPercent >= diskLimit) blocked.add("disk-used");
      else if (usedPercent >= policy.maxDiskUsedPercent - 5) warnings.add("disk-used");
      const reserve = policy.minFreeBytes * (this.blockedReasons.has("disk-reserve") ? 1.1 : 1);
      if (volume.availableBytes < reserve) blocked.add("disk-reserve");
      else if (volume.availableBytes < policy.minFreeBytes * 2) warnings.add("disk-reserve");
    }
    this.blockedReasons = blocked;
    if (blocked.size > 0) return { ...base, state: "blocked", reasons: [...blocked] };
    return { ...base, state: warnings.size > 0 ? "warning" : "normal", reasons: [...warnings] };
  }

  assertCanGrow(additionalBytes = 0): void {
    if (!Number.isFinite(additionalBytes) || additionalBytes < 0)
      throw new RangeError("Invalid growth size");
    const pressure = this.snapshot();
    if (pressure.state === "blocked" || pressure.state === "unknown") {
      throw new InsufficientStorageError(
        pressure.state === "unknown"
          ? "Storage capacity cannot be verified. Sync and background growth are paused until measurement recovers. Open Settings → Storage."
          : "Storage limit reached. Sync and background growth are paused; existing data remains available. Open Settings → Storage to reclaim space or change the limit. Growth resumes automatically after recovery.",
      );
    }
    if (additionalBytes === 0) return;
    const quotaExceeded =
      pressure.policy.maxBytes !== null &&
      (pressure.usageBytes ?? 0) + additionalBytes >= pressure.policy.maxBytes;
    const volumeExceeded = pressure.volumes.some((volume) => {
      const remaining = volume.availableBytes - additionalBytes;
      return (
        remaining < pressure.policy.minFreeBytes ||
        (1 - remaining / volume.totalBytes) * 100 >= pressure.policy.maxDiskUsedPercent
      );
    });
    if (quotaExceeded || volumeExceeded) {
      throw new InsufficientStorageError(
        "This operation would exceed the gateway storage limit or disk safety reserve. Open Settings → Storage to reclaim space or change the limit.",
      );
    }
  }
}

function validMeasurement(measurement: StorageMeasurement, now: number): boolean {
  return (
    Number.isFinite(measurement.usageBytes) &&
    measurement.usageBytes >= 0 &&
    Number.isFinite(measurement.measuredAt) &&
    measurement.measuredAt <= now &&
    measurement.volumes.length > 0 &&
    measurement.volumes.every(
      (volume) =>
        volume.id.length > 0 &&
        Number.isFinite(volume.totalBytes) &&
        volume.totalBytes > 0 &&
        Number.isFinite(volume.availableBytes) &&
        volume.availableBytes >= 0 &&
        volume.availableBytes <= volume.totalBytes,
    )
  );
}
