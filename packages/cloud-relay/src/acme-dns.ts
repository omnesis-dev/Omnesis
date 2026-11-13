// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { RelayError } from "./tunnels.js";

const hostnameSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
export const dnsChallengeValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const leaseSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    hostname: hostnameSchema,
    value: dnsChallengeValueSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type DnsChallengeLease = z.infer<typeof leaseSchema>;
export interface DnsChallengeProvider {
  create(lease: DnsChallengeLease, signal: AbortSignal): Promise<void>;
  remove(lease: DnsChallengeLease, signal: AbortSignal): Promise<void>;
}

export interface AcmeDnsOptions {
  file: string;
  suffix: string;
  provider: DnsChallengeProvider;
  ttlMs?: number;
  maxLeases?: number;
  allowApex?: boolean;
}

/** Only TXT records for a registered gateway's exact hostname may be leased. Intents survive process crashes. */
export class AcmeDnsChallenges {
  private leases: DnsChallengeLease[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly admissions = new Map<string, number>();
  private queued = 0;
  private expiring: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private constructor(private readonly options: AcmeDnsOptions) {
    hostnameSchema.parse(options.suffix);
    if (
      !Number.isSafeInteger(options.ttlMs ?? 600_000) ||
      (options.ttlMs ?? 600_000) <= 0 ||
      (options.ttlMs ?? 600_000) > 600_000 ||
      !Number.isSafeInteger(options.maxLeases ?? 32) ||
      (options.maxLeases ?? 32) <= 0 ||
      (options.maxLeases ?? 32) > 32
    )
      throw new Error("Invalid DNS challenge limits");
  }
  static async open(options: AcmeDnsOptions): Promise<AcmeDnsChallenges> {
    const service = new AcmeDnsChallenges(options);
    try {
      service.leases = z
        .array(leaseSchema)
        .max(32)
        .parse(await readPrivateJson(options.file));
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        // Journal validation can contain sensitive input; expose only fixed recovery guidance.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Invalid DNS challenge journal");
      }
    }
    // Every prior process's intent is abandoned; deletion is idempotent even if creation never completed.
    const cleanupSignal = AbortSignal.timeout(15_000);
    for (const lease of [...service.leases]) await service.removeLease(lease, cleanupSignal);
    service.timer = setInterval(() => {
      void service.expire().catch(() => {});
    }, 30_000);
    service.timer.unref();
    return service;
  }
  private serialize<T>(run: () => Promise<T>, accountId?: string): Promise<T> {
    if (accountId !== undefined) {
      if (this.queued >= 8 || (this.admissions.get(accountId) ?? 0) >= 2)
        return Promise.reject(new RelayError(429, "DNS operation admission capacity reached"));
      this.queued++;
      this.admissions.set(accountId, (this.admissions.get(accountId) ?? 0) + 1);
    }
    const next = this.pending.then(run).finally(() => {
      if (accountId !== undefined) {
        this.queued--;
        const count = this.admissions.get(accountId)! - 1;
        if (count === 0) this.admissions.delete(accountId);
        else this.admissions.set(accountId, count);
      }
    });
    this.pending = next.catch(() => {});
    return next;
  }
  private scope(hostname: string): void {
    hostnameSchema.parse(hostname);
    if (
      !(this.options.allowApex && hostname === this.options.suffix) &&
      !hostname.endsWith(`.${this.options.suffix}`)
    )
      throw new RelayError(403, "DNS challenge hostname is outside the managed zone");
  }
  create(
    accountId: string,
    hostname: string,
    value: string,
    callerSignal?: AbortSignal,
  ): Promise<{ id: string; expiresAt: number }> {
    return this.serialize(async () => {
      if (this.closed) throw new RelayError(503, "DNS challenge service is closed");
      this.scope(hostname);
      dnsChallengeValueSchema.parse(value);
      const bound = AbortSignal.timeout(15_000);
      const signal = callerSignal ? AbortSignal.any([callerSignal, bound]) : bound;
      signal.throwIfAborted();
      for (const lease of [...this.leases])
        if (lease.expiresAt <= Date.now()) await this.removeLease(lease, signal);
      if (
        this.leases.some((lease) => lease.accountId === accountId) ||
        this.leases.length >= (this.options.maxLeases ?? 32)
      )
        throw new RelayError(429, "DNS challenge capacity reached");
      const lease = leaseSchema.parse({
        id: randomUUID(),
        accountId,
        hostname,
        value,
        expiresAt: Date.now() + (this.options.ttlMs ?? 600_000),
      });
      this.leases.push(lease);
      try {
        await savePrivateJson(this.options.file, this.leases);
      } catch (error) {
        this.leases.pop();
        throw error;
      }
      try {
        signal.throwIfAborted();
        await this.options.provider.create(lease, signal);
        signal.throwIfAborted();
      } catch {
        try {
          await this.removeLease(lease);
        } catch {
          /* The durable intent is retained for expiry/restart cleanup. */
        }
        callerSignal?.throwIfAborted();
        throw new RelayError(502, "DNS challenge publication failed");
      }
      return { id: lease.id, expiresAt: lease.expiresAt };
    }, accountId);
  }
  remove(accountId: string, id: string): Promise<void> {
    return this.serialize(async () => {
      const lease = this.leases.find((item) => item.id === id);
      if (!lease) return;
      if (lease.accountId !== accountId)
        throw new RelayError(403, "DNS challenge belongs to another gateway");
      await this.removeLease(lease);
    }, accountId);
  }
  /** Ends every lease of a gateway that is no longer registered. */
  forget(accountId: string): Promise<void> {
    return this.serialize(async () => {
      for (const lease of this.leases.filter((item) => item.accountId === accountId))
        await this.removeLease(lease);
    });
  }
  expire(): Promise<void> {
    return (this.expiring ??= this.serialize(async () => {
      const signal = AbortSignal.timeout(15_000);
      for (const lease of [...this.leases])
        if (lease.expiresAt <= Date.now()) await this.removeLease(lease, signal);
    }).finally(() => {
      this.expiring = undefined;
    }));
  }
  private async removeLease(
    lease: DnsChallengeLease,
    signal = AbortSignal.timeout(15_000),
  ): Promise<void> {
    this.scope(lease.hostname);
    signal.throwIfAborted();
    await this.options.provider.remove(lease, signal);
    const remaining = this.leases.filter((item) => item.id !== lease.id);
    await savePrivateJson(this.options.file, remaining);
    this.leases = remaining;
  }
  snapshot(): { dnsLeases: number; dnsQueued: number } {
    return { dnsLeases: this.leases.length, dnsQueued: this.queued };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const signal = AbortSignal.timeout(15_000);
    await this.serialize(async () => {
      for (const lease of [...this.leases]) await this.removeLease(lease, signal);
    });
  }
}
