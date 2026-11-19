// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { BrokerStore } from "./dns-broker-core.js";
import type { BrokerRequest } from "./dns-broker-contract.js";
import type { BrokerZoneCapacity } from "./dns-broker-zone.js";

export class PublicAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESERVATION_MS = 15 * 60_000;
const allocationSchema = z.object({
  expiresAt: z.number().int().positive().optional(),
  publishedAt: z.number().int().nonnegative().optional(),
});
const counterSchema = z.object({ count: z.number().int().nonnegative(), expiresAt: z.number() });
const entrySchema = z.object({
  released: z.boolean().optional(),
  accountUri: z.string().optional(),
});

export interface PublicAdmissionLimits {
  networkPerHour: number;
  networkPerDay: number;
  ownerPerDay: number;
  totalPerDay: number;
  /** Slots kept for simultaneous TXT renewals and CAA replacement writes. */
  reservedRecords: number;
}

export const DEFAULT_PUBLIC_ADMISSION_LIMITS: PublicAdmissionLimits = {
  networkPerHour: 3,
  networkPerDay: 10,
  ownerPerDay: 3,
  totalPerDay: 1000,
  reservedRecords: 36,
};

export interface AdmissionCapacitySnapshot extends BrokerZoneCapacity {
  startedAt: number;
  revision: number;
}

/**
 * New allocations spend durable, expiring budgets. Active names reserve their missing DNS
 * records; released identities retain ownership but must obtain capacity again to reconnect.
 * Mutating methods are called inside the broker's serialized admission transaction.
 */
export class BrokerAdmissionBudget {
  private revision = 0;
  private snapshot: AdmissionCapacitySnapshot | undefined;
  private reading: Promise<AdmissionCapacitySnapshot> | undefined;
  private initialized: Promise<void> | undefined;
  readonly limits: PublicAdmissionLimits;
  constructor(
    private readonly options: {
      store: BrokerStore;
      capacity(signal: AbortSignal): Promise<BrokerZoneCapacity>;
      now(): number;
      limits?: Partial<PublicAdmissionLimits>;
      renewalSlots?: number;
    },
  ) {
    this.limits = { ...DEFAULT_PUBLIC_ADMISSION_LIMITS, ...options.limits };
    for (const limit of Object.values(this.limits))
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("DNS public admission limits must be positive integers");
  }

  /** A one-time migration indexes active legacy bindings; admissions never scan historical owners. */
  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      if ((await this.options.store.get("meta:public-allocation-index")) === 1) return;
      for (const [key] of await this.options.store.list("allocation:")) {
        const raw = await this.options.store.get(`name:${key.slice("allocation:".length)}`);
        if (raw === undefined || entrySchema.parse(raw).released)
          await this.options.store.delete(key);
      }
      for (const [key, raw] of await this.options.store.list("name:")) {
        const entry = entrySchema.parse(raw);
        if (!entry.released && entry.accountUri) {
          const allocation = `allocation:${key.slice("name:".length)}`;
          if ((await this.options.store.get(allocation)) === undefined)
            await this.options.store.put(allocation, { publishedAt: 0 });
        }
      }
      await this.options.store.put("meta:public-allocation-index", 1);
    })();
    return this.initialized;
  }

  /** Provider I/O is bounded and happens before taking the broker admission lock. */
  async capacity(): Promise<AdmissionCapacitySnapshot> {
    const now = this.options.now();
    if (
      this.snapshot &&
      this.snapshot.revision === this.revision &&
      now - this.snapshot.startedAt < 15_000
    )
      return this.snapshot;
    this.reading ??= (async () => {
      const revision = this.revision;
      const startedAt = this.options.now();
      const value = await this.options.capacity(AbortSignal.timeout(5000));
      if (
        !Number.isSafeInteger(value.usage) ||
        value.usage < 0 ||
        !Number.isSafeInteger(value.quota) ||
        value.quota <= 0 ||
        !Number.isSafeInteger(value.recordsPerName) ||
        value.recordsPerName < 2 ||
        value.recordsPerName > 16
      )
        throw new PublicAdmissionError(503, "dns-capacity-unavailable");
      const snapshot = { ...value, revision, startedAt };
      this.snapshot = snapshot;
      return snapshot;
    })()
      .catch(() => {
        throw new PublicAdmissionError(503, "dns-capacity-unavailable");
      })
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  /** A new publication invalidates snapshots which may have observed only part of its writes. */
  mutation(): void {
    this.revision++;
    this.snapshot = undefined;
  }

  async hasAllocation(
    hostname: string,
    entry: { released?: boolean; accountUri?: string },
  ): Promise<boolean> {
    if (entry.released) return false;
    if (entry.accountUri) return true;
    const value = await this.options.store.get(`allocation:${hostname}`);
    if (value === undefined) return false;
    const allocation = allocationSchema.parse(value);
    return allocation.expiresAt === undefined || allocation.expiresAt > this.options.now();
  }

  async reserve(
    request: BrokerRequest,
    network: string,
    owner: string,
    snapshot: AdmissionCapacitySnapshot,
  ): Promise<void> {
    if (snapshot.revision !== this.revision)
      throw new PublicAdmissionError(409, "dns-capacity-retry");
    const now = this.options.now();
    let missing = snapshot.recordsPerName;
    for (const [key, value] of await this.options.store.list("allocation:")) {
      const hostname = key.slice("allocation:".length);
      const allocation = allocationSchema.parse(value);
      if (allocation.expiresAt !== undefined && allocation.expiresAt <= now) continue;
      // Published records and total usage come from the same bounded inventory. A failed or
      // in-progress publication retains its full reservation until a successful retry/release.
      const count =
        allocation.publishedAt === undefined ? 0 : (snapshot.managedRecords[hostname] ?? 0);
      missing += Math.max(0, snapshot.recordsPerName - count);
    }
    const headroom = Math.max(
      this.limits.reservedRecords,
      (this.options.renewalSlots ?? 32) + snapshot.recordsPerName,
    );
    if (snapshot.usage + missing + headroom > snapshot.quota)
      throw new PublicAdmissionError(507, "dns-capacity");

    const buckets = [
      { duration: DAY, id: "all", maximum: this.limits.totalPerDay },
      { duration: HOUR, id: `network:${network}`, maximum: this.limits.networkPerHour },
      { duration: DAY, id: `network:${network}`, maximum: this.limits.networkPerDay },
      { duration: DAY, id: `owner:${owner}`, maximum: this.limits.ownerPerDay },
    ];
    const writes: Array<{ key: string; count: number; expiresAt: number }> = [];
    for (const bucket of buckets) {
      const start = Math.floor(now / bucket.duration) * bucket.duration;
      const key = `budget:${bucket.duration}:${start}:${bucket.id}`;
      const raw = await this.options.store.get(key);
      const count = raw === undefined ? 0 : counterSchema.parse(raw).count;
      if (count >= bucket.maximum) throw new PublicAdmissionError(429, "dns-allocation-rate");
      writes.push({ key, count: count + 1, expiresAt: start + bucket.duration + HOUR });
    }
    // Check every allowance first. A storage failure can overcharge a retry, never undercharge it.
    for (const row of writes)
      await this.options.store.put(row.key, { count: row.count, expiresAt: row.expiresAt });
    await this.options.store.put(`allocation:${request.hostname}`, {
      expiresAt: now + RESERVATION_MS,
    });
  }

  async publicationStarted(hostname: string): Promise<void> {
    this.mutation();
    // No expiry while partial writes may remain at the provider.
    await this.options.store.put(`allocation:${hostname}`, {});
  }

  async published(hostname: string): Promise<void> {
    this.mutation();
    await this.options.store.put(`allocation:${hostname}`, { publishedAt: this.options.now() });
  }

  async publicationFailed(hostname: string): Promise<void> {
    this.mutation();
    await this.options.store.put(`allocation:${hostname}`, {});
  }

  async released(hostname: string): Promise<void> {
    this.mutation();
    await this.options.store.delete(`allocation:${hostname}`);
  }

  async expire(): Promise<number | undefined> {
    const now = this.options.now();
    let next: number | undefined;
    for (const prefix of ["budget:", "allocation:"]) {
      for (const [key, raw] of await this.options.store.list(prefix)) {
        const value = prefix === "budget:" ? counterSchema.parse(raw) : allocationSchema.parse(raw);
        if (value.expiresAt === undefined) continue;
        if (value.expiresAt <= now) await this.options.store.delete(key);
        else next = Math.min(next ?? value.expiresAt, value.expiresAt);
      }
    }
    return next;
  }
}
