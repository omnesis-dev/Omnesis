// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  accountBoundCaaValue,
  brokerRequestDigest,
  type BrokerRequest,
} from "./dns-broker-contract.js";
import { PublicAdmissionError, type BrokerAdmissionBudget } from "./dns-broker-admission-budget.js";
import type { BrokerStore, BrokerEntry } from "./dns-broker-core.js";
import type { BrokerZone, TxtLease } from "./dns-broker-zone.js";

const leaseSchema = z.object({
  id: z.string().uuid(),
  hostname: z.string(),
  value: z.string(),
  expiresAt: z.number(),
});
const CAA_REASSERT_MS = 3_600_000;
const CAA_CHANGE_MS = 600_000;
type Lane = "txt" | "configuration";
interface Slot {
  digest: string;
  promise: Promise<unknown>;
}

/**
 * Public owners can work on their own name only. A stalled provider call occupies one
 * bounded slot, never the shared metadata lock or another owner's renewal lane.
 */
export class DnsPublicOperations {
  private readonly names = new Map<string, Slot>();
  private readonly providerActive: Record<Lane, number> = { txt: 0, configuration: 0 };
  private readonly rates = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly options: {
      store: BrokerStore;
      zone: BrokerZone;
      budget: BrokerAdmissionBudget;
      now(): number;
      serialize<T>(run: () => Promise<T>): Promise<T>;
      entry(hostname: string): Promise<BrokerEntry | undefined>;
      claim(request: BrokerRequest): Promise<unknown>;
      maxLeases: number;
      leaseTtlMs: number;
      issuer: string;
      accountUriPrefix: string;
    },
  ) {}

  private rate(key: string, duration: number, maximum: number): void {
    const now = this.options.now();
    const start = Math.floor(now / duration) * duration;
    for (const [id, value] of this.rates) if (value.start + 3_600_000 <= now) this.rates.delete(id);
    const value = this.rates.get(key);
    const count = value?.start === start ? value.count : 0;
    if (count >= maximum) throw new PublicAdmissionError(429, "name-provider-rate");
    this.rates.set(key, { start, count: count + 1 });
  }

  private async provider<T>(lane: Lane, run: () => Promise<T>): Promise<T> {
    const maximum = lane === "txt" ? 8 : 2;
    if (this.providerActive[lane] >= maximum)
      throw new PublicAdmissionError(429, "dns-provider-busy");
    this.rate(`provider:${lane}`, 60_000, lane === "txt" ? 30 : 12);
    this.providerActive[lane]++;
    try {
      return await run();
    } finally {
      this.providerActive[lane]--;
    }
  }

  private owned(request: BrokerRequest, entry: BrokerEntry | undefined): BrokerEntry {
    if (
      !entry ||
      entry.gatewayId !== request.gatewayId ||
      entry.ownerPublicKey !== request.ownerPublicKey
    )
      throw new PublicAdmissionError(403, "name-owned-by-another-key");
    return entry;
  }

  private async active(request: BrokerRequest): Promise<BrokerEntry> {
    const entry = this.owned(request, await this.options.entry(request.hostname));
    if (entry.released || !(await this.options.budget.hasAllocation(request.hostname, entry)))
      throw new PublicAdmissionError(403, "name-admission-required");
    return entry;
  }

  async run(request: BrokerRequest): Promise<unknown> {
    const digest = await brokerRequestDigest(request);
    const existing = this.names.get(request.hostname);
    if (existing) {
      if (request.operation.type === "caa" && existing.digest === digest) return existing.promise;
      throw new PublicAdmissionError(429, "name-operation-busy");
    }
    const slot = {} as Slot;
    slot.digest = digest;
    // Defer execution until the ownership record is installed, including synchronous failures.
    slot.promise = Promise.resolve().then(() => this.perform(request));
    this.names.set(request.hostname, slot);
    try {
      return await slot.promise;
    } finally {
      if (this.names.get(request.hostname) === slot) this.names.delete(request.hostname);
    }
  }

  private async perform(request: BrokerRequest): Promise<unknown> {
    const { hostname, operation } = request;
    const entry = this.owned(request, await this.options.entry(hostname));
    if (operation.type === "claim")
      return this.options.serialize(() => this.options.claim(request));
    if (operation.type === "txt-remove") {
      const raw = await this.options.store.get(`lease:${operation.leaseId}`);
      if (raw === undefined) return { removed: true };
      const lease = leaseSchema.parse(raw);
      if (lease.hostname !== hostname) throw new PublicAdmissionError(403, "lease-of-another-name");
      await this.provider("txt", () => this.remove(lease));
      return { removed: true };
    }
    if (operation.type === "release") {
      if (entry.released) return { released: true };
      await this.provider("configuration", async () => {
        this.options.budget.mutation();
        try {
          for (const lease of await this.leases())
            if (lease.hostname === hostname) await this.remove(lease);
          await this.options.zone.removeName(hostname, AbortSignal.timeout(15_000));
        } catch {
          throw new PublicAdmissionError(502, "dns-removal-failed");
        } finally {
          this.options.budget.mutation();
        }
        await this.options.serialize(async () => {
          const current = this.owned(request, await this.options.entry(hostname));
          const { accountUri: _account, caaPublishedAt: _published, ...rest } = current;
          await this.options.store.put(`name:${hostname}`, { ...rest, released: true });
          await this.options.budget.released(hostname);
        });
      });
      return { released: true };
    }
    if (entry.released || !(await this.options.budget.hasAllocation(hostname, entry)))
      throw new PublicAdmissionError(403, "name-admission-required");
    if (operation.type === "caa") {
      if (
        !operation.accountUri.startsWith(this.options.accountUriPrefix) ||
        operation.accountUri.length === this.options.accountUriPrefix.length
      )
        throw new PublicAdmissionError(400, "account-not-accepted");
      const age = this.options.now() - (entry.caaPublishedAt ?? 0);
      if (entry.accountUri === operation.accountUri && age >= 0 && age < CAA_REASSERT_MS)
        return { caa: true };
      if (
        entry.accountUri !== operation.accountUri &&
        entry.caaPublishedAt !== undefined &&
        age < CAA_CHANGE_MS
      )
        throw new PublicAdmissionError(429, "name-provider-rate");
      this.rate(`caa:${hostname}`, 30_000, 1);
      await this.provider("configuration", async () => {
        await this.options.serialize(async () => {
          await this.active(request);
          await this.options.budget.publicationStarted(hostname);
        });
        try {
          await this.options.zone.publishName(
            hostname,
            accountBoundCaaValue(this.options.issuer, operation.accountUri),
            AbortSignal.timeout(15_000),
          );
        } catch {
          await this.options.serialize(() => this.options.budget.publicationFailed(hostname));
          throw new PublicAdmissionError(502, "dns-publication-failed");
        }
        await this.options.serialize(async () => {
          const current = this.owned(request, await this.options.entry(hostname));
          await this.options.budget.published(hostname);
          await this.options.store.put(`name:${hostname}`, {
            ...current,
            accountUri: operation.accountUri,
            caaPublishedAt: this.options.now(),
          });
        });
      });
      return { caa: true };
    }
    this.rate(`txt:${hostname}`, 3_600_000, 6);
    return this.provider("txt", async () => {
      const lease = await this.options.serialize(async () => {
        await this.active(request);
        const leases = await this.leases();
        // Expired records still consume capacity until their alarm has removed them safely.
        if (
          leases.some((row) => row.hostname === hostname) ||
          leases.length >= this.options.maxLeases
        )
          throw new PublicAdmissionError(429, "lease-capacity");
        const lease = {
          id: crypto.randomUUID(),
          hostname,
          value: operation.value,
          expiresAt: this.options.now() + this.options.leaseTtlMs,
        };
        await this.options.store.put(`lease:${lease.id}`, lease);
        return lease;
      });
      try {
        await this.options.zone.createTxt(lease, AbortSignal.timeout(15_000));
      } catch {
        await this.remove(lease).catch(() => {});
        throw new PublicAdmissionError(502, "dns-publication-failed");
      }
      return { id: lease.id, expiresAt: lease.expiresAt };
    });
  }

  private async leases(): Promise<TxtLease[]> {
    return [...(await this.options.store.list("lease:")).values()].map((value) =>
      leaseSchema.parse(value),
    );
  }

  private async remove(lease: TxtLease): Promise<void> {
    await this.options.zone.removeTxt(lease, AbortSignal.timeout(15_000));
    await this.options.serialize(() => this.options.store.delete(`lease:${lease.id}`));
  }

  /** Alarm retries never join a name's pending work or occupy the global admission lock. */
  async expireLeases(): Promise<number | undefined> {
    const now = this.options.now();
    await Promise.all(
      (await this.leases())
        .filter((row) => row.expiresAt <= now)
        .map(async (lease) => {
          if (this.names.has(lease.hostname)) return;
          const slot = { digest: "cleanup", promise: Promise.resolve() as Promise<unknown> };
          this.names.set(lease.hostname, slot);
          slot.promise = this.provider("txt", () => this.remove(lease));
          try {
            await slot.promise;
          } catch {
            /* The journal retains it for the next bounded retry. */
          } finally {
            if (this.names.get(lease.hostname) === slot) this.names.delete(lease.hostname);
          }
        }),
    );
    const leases = await this.leases();
    return leases.length
      ? Math.min(...leases.map((row) => (row.expiresAt > now ? row.expiresAt : now + 60_000)))
      : undefined;
  }
}
