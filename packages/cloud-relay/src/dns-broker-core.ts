// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The DNS broker: the only holder of the DNS token that can prove control of gateway names.
 * A name is bound to the first owner key that claims it, and only that key may lease its
 * `_acme-challenge` TXT record or set its CAA record. The relay holds nothing that counts here.
 *
 * Runs in a Cloudflare Worker's Durable Object and on Node alike: zod and the Web platform only.
 */
import { z } from "zod";
import { BrokerError } from "./dns-broker-error.js";
export { BrokerError } from "./dns-broker-error.js";
import { brokerHttp, brokerOrigin } from "./dns-broker-http.js";
import {
  DNS_BROKER_PROTOCOL,
  accountBoundCaaValue,
  accountUriSchema,
  brokerChallengeSchema,
  brokerChallengeInputSchema,
  brokerChallengeAdmissionTranscript,
  brokerCompletionSchema,
  brokerRequestDigest,
  brokerRequestSchema,
  hostedLabel,
  ownerPublicKeySchema,
  registryImportSchema,
  relayDomainSchema,
  sha256Hex,
  verifyOwnerSignature,
  verifyBrokerSignature,
  type RegistryEntry,
  type BrokerChallenge,
  type BrokerHealth,
  type BrokerRequest,
} from "./dns-broker-contract.js";
import {
  BrowserVerificationRequired,
  DnsPublicAdmission,
  type TurnstileVerification,
} from "./dns-broker-public-admission.js";
import { PublicAdmissionError, type PublicAdmissionLimits } from "./dns-broker-admission-budget.js";
import { DnsPublicOperations } from "./dns-broker-public-operations.js";
import type { BrokerZone, TxtLease } from "./dns-broker-zone.js";

/** Durable key-value storage; a Durable Object's storage and a private file both fit. */
export interface BrokerStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Map<string, unknown>>;
}

export interface DnsBrokerOptions {
  /** The broker's own origin, which every owner signature names. */
  origin: string;
  relayDomain: string;
  store: BrokerStore;
  zone: BrokerZone;
  caa?: { issuer?: string; accountUriPrefix?: string };
  /** Enables the one-time registry import; unset, the import route doesn't exist. */
  importToken?: string;
  now?: () => number;
  leaseTtlMs?: number;
  challengeTtlMs?: number;
  maxChallenges?: number;
  maxLeases?: number;
  maxNames?: number;
  /** Operator-approved identities for new names. An empty list closes new allocations. */
  approvedNewOwners?: readonly RegistryEntry[];
  /** Arms durable maintenance when a journal changes, before provider I/O begins. */
  onMaintenance?(): Promise<void>;
  /** Independent automatic browser checks and capacity budgets for public signup. */
  publicAdmission?: {
    secret: string;
    siteKey: string;
    verify(input: TurnstileVerification): Promise<boolean>;
    limits?: Partial<PublicAdmissionLimits>;
  };
}

const entrySchema = z
  .object({
    gatewayId: z.string().uuid(),
    ownerPublicKey: ownerPublicKeySchema,
    claimedAt: z.number().int().nonnegative(),
    source: z.enum(["claim", "import"]),
    released: z.boolean().optional(),
    accountUri: accountUriSchema.optional(),
    caaPublishedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
export type BrokerEntry = Entry;
const leaseSchema = z
  .object({
    id: z.string().uuid(),
    hostname: z.string(),
    value: z.string(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const pendingSchema = z
  .object({ request: brokerRequestSchema, challenge: brokerChallengeSchema })
  .strict();

/** Stored state that doesn't parse is a broker failure, never a client's invalid request. */
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BrokerError(500, "broker-failure");
  return result.data;
}

const LETS_ENCRYPT_ACCOUNTS = "https://acme-v02.api.letsencrypt.org/acme/acct/";
const NAME_COUNT = "meta:names";
export class DnsBroker {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly origin: string;
  private readonly relayDomain: string;
  private readonly issuer: string;
  private readonly accountUriPrefix: string;
  private readonly now: () => number;
  private readonly publicAdmission: DnsPublicAdmission | undefined;
  private readonly publicOperations: DnsPublicOperations | undefined;
  private readonly publicReady: Promise<void> | undefined;
  private readonly limits: {
    leaseTtlMs: number;
    challengeTtlMs: number;
    maxChallenges: number;
    maxLeases: number;
    maxNames: number;
  };
  constructor(private readonly options: DnsBrokerOptions) {
    const original = options.store;
    const dirty = (key: string) =>
      ["lease:", "used:", "allocation:", "budget:"].some((prefix) => key.startsWith(prefix));
    this.options = {
      ...options,
      store: {
        get: (key) => original.get(key),
        list: (prefix) => original.list(prefix),
        put: async (key, value) => {
          await original.put(key, value);
          if (dirty(key)) await options.onMaintenance?.();
          if (!options.publicAdmission && key.startsWith("name:"))
            await original.delete("meta:public-allocation-index");
        },
        delete: async (key) => {
          await original.delete(key);
          if (dirty(key)) await options.onMaintenance?.();
        },
      },
    };
    this.origin = brokerOrigin(options.origin);
    this.relayDomain = relayDomainSchema.parse(options.relayDomain);
    this.issuer = relayDomainSchema.parse(options.caa?.issuer ?? "letsencrypt.org");
    this.accountUriPrefix = accountUriSchema.parse(
      options.caa?.accountUriPrefix ?? LETS_ENCRYPT_ACCOUNTS,
    );
    this.now = options.now ?? Date.now;
    this.limits = {
      leaseTtlMs: options.leaseTtlMs ?? 600_000,
      challengeTtlMs: options.challengeTtlMs ?? 60_000,
      maxChallenges: options.maxChallenges ?? 64,
      maxLeases: options.maxLeases ?? 32,
      maxNames: options.maxNames ?? 100_000,
    };
    for (const [value, max] of [
      [this.limits.leaseTtlMs, 600_000],
      [this.limits.challengeTtlMs, 60_000],
      [this.limits.maxChallenges, 256],
      [this.limits.maxLeases, 64],
      [this.limits.maxNames, 1_000_000],
    ] as const)
      if (!Number.isSafeInteger(value) || value <= 0 || value > max)
        throw new Error("Invalid DNS broker limits");
    if (options.importToken !== undefined && options.importToken.length < 32)
      throw new Error("The registry import token is too short");
    if (options.publicAdmission) {
      if (options.approvedNewOwners !== undefined || !options.zone.capacity)
        throw new Error(
          "Public DNS admission requires provider capacity and no manual approval list",
        );
      this.publicAdmission = new DnsPublicAdmission({
        ...options.publicAdmission,
        origin: this.origin,
        now: this.now,
        store: this.options.store,
        capacity: (signal) => options.zone.capacity!(signal),
        renewalSlots: this.limits.maxLeases,
      });
      this.publicOperations = new DnsPublicOperations({
        store: this.options.store,
        zone: options.zone,
        budget: this.publicAdmission.budget,
        now: this.now,
        serialize: (run) => this.serialize(run),
        entry: (hostname) => this.entry(hostname),
        claim: (request) => this.perform(request),
        maxLeases: this.limits.maxLeases,
        leaseTtlMs: this.limits.leaseTtlMs,
        issuer: this.issuer,
        accountUriPrefix: this.accountUriPrefix,
      });
      this.publicReady = this.publicAdmission.budget.initialize();
      void this.publicReady.catch(() => {});
    }
  }

  health(): BrokerHealth {
    return {
      protocol: DNS_BROKER_PROTOCOL,
      relayDomain: this.relayDomain,
      ...(this.options.approvedNewOwners !== undefined || this.publicAdmission
        ? { ownerProofRequired: true as const }
        : {}),
      ...(this.publicAdmission ? { publicAdmission: true as const } : {}),
      caa: { issuer: this.issuer, accountUriPrefix: this.accountUriPrefix },
    };
  }

  /** Every route, as a fetch handler. Errors carry a fixed code and never echo input. */
  handle(request: Request, context?: { clientAddress?: string }): Promise<Response> {
    return brokerHttp(request, {
      ready: this.publicReady,
      health: () => this.health(),
      challenge: (input) => this.challenge(input, context),
      complete: (input) => this.complete(input),
      ...(this.options.importToken !== undefined
        ? {
            importRegistry: async (authorization: string | null, read: () => Promise<unknown>) => {
              await this.authorizeImport(authorization);
              return this.importRegistry(await read());
            },
          }
        : {}),
      ...(this.publicAdmission
        ? {
            publicAdmission: {
              page: (input: Request) => this.publicAdmission!.page(input),
              verify: (input: Request) => this.admitBrowser(input),
            },
          }
        : {}),
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async derived(hostname: string, gatewayId: string): Promise<boolean> {
    return hostname === `${await hostedLabel(gatewayId)}.${this.relayDomain}`;
  }

  async challenge(input: unknown, context?: { clientAddress?: string }): Promise<BrokerChallenge> {
    await this.publicReady;
    const { proof, ...request } = brokerChallengeInputSchema.parse(input);
    // Only a gateway's own derived name under the relay domain is ever brokered.
    if (!(await this.derived(request.hostname, request.gatewayId)))
      throw new BrokerError(403, "name-not-derived");
    const requestDigest = await brokerRequestDigest(request);
    const protectedAdmission =
      this.options.approvedNewOwners !== undefined || this.publicAdmission !== undefined;
    if (protectedAdmission) {
      const now = this.now();
      if (
        !proof ||
        proof.expiresAt <= now ||
        proof.expiresAt > now + 60_000 ||
        !(await verifyBrokerSignature(
          request.ownerPublicKey,
          brokerChallengeAdmissionTranscript(this.origin, requestDigest, proof.expiresAt),
          proof.signature,
        ))
      ) {
        throw new BrokerError(401, "owner-proof-required");
      }
    }
    if (this.publicAdmission) {
      await this.assertPublicOwner(request, context);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      return this.publicAdmission.operation(request, {
        protocol: DNS_BROKER_PROTOCOL,
        brokerOrigin: this.origin,
        challengeId: crypto.randomUUID(),
        nonce: [...nonce].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        requestDigest,
        expiresAt: this.now() + this.limits.challengeTtlMs,
      });
    }
    return this.serialize(async () => {
      const now = this.now();
      if (protectedAdmission) await this.assertAdmission(request);
      let pending = 0;
      for (const [key, value] of await this.options.store.list("challenge:")) {
        const row = pendingSchema.safeParse(value);
        if (!row.success || row.data.challenge.expiresAt <= now)
          await this.options.store.delete(key);
        else {
          if (protectedAdmission && row.data.request.hostname === request.hostname) {
            if (row.data.challenge.requestDigest === requestDigest) return row.data.challenge;
            throw new BrokerError(429, "name-challenge-pending");
          }
          pending++;
        }
      }
      if (pending >= this.limits.maxChallenges) throw new BrokerError(429, "challenge-capacity");
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const challenge: BrokerChallenge = {
        protocol: DNS_BROKER_PROTOCOL,
        brokerOrigin: this.origin,
        challengeId: crypto.randomUUID(),
        nonce: [...nonce].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        requestDigest,
        expiresAt: now + this.limits.challengeTtlMs,
      };
      await this.options.store.put(`challenge:${challenge.challengeId}`, { request, challenge });
      return challenge;
    });
  }

  async complete(input: unknown): Promise<unknown> {
    await this.publicReady;
    const value = brokerCompletionSchema.parse(input);
    if (this.publicAdmission) {
      if (!value.ticket) throw new BrokerError(401, "challenge-unknown");
      const { request, challenge } = await this.publicAdmission.readOperation(value.ticket);
      if (
        challenge.challengeId !== value.challengeId ||
        !(await verifyOwnerSignature(request.ownerPublicKey, challenge, value.ownerSignature))
      )
        throw new BrokerError(401, "signature-refused");
      await this.serialize(async () => {
        if (challenge.expiresAt <= this.now()) throw new BrokerError(401, "challenge-unknown");
        await this.assertPublicOwner(request);
        await this.publicAdmission!.consume(request, challenge);
      });
      return this.publicOperations!.run(request);
    }
    return this.serialize(async () => {
      const key = `challenge:${value.challengeId}`;
      const row = pendingSchema.safeParse(await this.options.store.get(key));
      if (!row.success) throw new BrokerError(401, "challenge-unknown");
      const protectedAdmission = this.options.approvedNewOwners !== undefined;
      if (!protectedAdmission) await this.options.store.delete(key);
      const { request, challenge } = row.data;
      if (challenge.expiresAt <= this.now()) throw new BrokerError(401, "challenge-unknown");
      if (!(await verifyOwnerSignature(request.ownerPublicKey, challenge, value.ownerSignature)))
        throw new BrokerError(401, "signature-refused");
      if (protectedAdmission) {
        await this.options.store.delete(key);
        await this.assertAdmission(request);
      }
      return this.perform(request);
    });
  }

  private async assertPublicOwner(
    request: BrokerRequest,
    context?: { clientAddress?: string },
  ): Promise<void> {
    const entry = await this.entry(request.hostname);
    if (
      entry &&
      (entry.gatewayId !== request.gatewayId || entry.ownerPublicKey !== request.ownerPublicKey)
    )
      throw new BrokerError(409, "name-taken");
    if (
      entry &&
      (request.operation.type === "release" ||
        request.operation.type === "txt-remove" ||
        (await this.publicAdmission!.budget.hasAllocation(request.hostname, entry)))
    )
      return;
    if (request.operation.type !== "claim") throw new BrokerError(403, "name-admission-required");
    throw new BrowserVerificationRequired(
      await this.publicAdmission!.verification(request, context?.clientAddress),
    );
  }

  private async admitBrowser(request: Request): Promise<{ claimed: true }> {
    const admission = this.publicAdmission!;
    // Verification and DNS inventory calls never occupy the serialized operation queue.
    const verified = await admission.verifyBrowser(request);
    const owner = await admission.ownerBucket(verified.request);
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await admission.budget.capacity();
      try {
        return await this.serialize(async () => {
          if (verified.expiresAt <= this.now()) throw new BrokerError(401, "verification-expired");
          const entry = await this.entry(verified.request.hostname);
          if (
            entry &&
            (entry.gatewayId !== verified.request.gatewayId ||
              entry.ownerPublicKey !== verified.request.ownerPublicKey)
          )
            throw new BrokerError(409, "name-taken");
          if (!entry || !(await admission.budget.hasAllocation(verified.request.hostname, entry))) {
            await admission.budget.reserve(verified.request, verified.network, owner, snapshot);
          }
          await this.perform(verified.request);
          return { claimed: true };
        });
      } catch (error) {
        if (!(error instanceof PublicAdmissionError) || error.code !== "dns-capacity-retry")
          throw error;
      }
    }
    throw new BrokerError(503, "dns-capacity-unavailable");
  }

  private async assertAdmission(request: BrokerRequest): Promise<void> {
    const entry = await this.entry(request.hostname);
    const sameOwner = (owner: Pick<RegistryEntry, "gatewayId" | "ownerPublicKey">) =>
      owner.gatewayId === request.gatewayId && owner.ownerPublicKey === request.ownerPublicKey;
    if (entry) {
      if (!sameOwner(entry)) throw new BrokerError(409, "name-taken");
      return;
    }
    if (
      request.operation.type !== "claim" ||
      !this.options.approvedNewOwners?.some(
        (owner) => owner.hostname === request.hostname && sameOwner(owner),
      )
    ) {
      throw new BrokerError(403, "name-admission-required");
    }
  }

  private async entry(hostname: string): Promise<Entry | undefined> {
    const value = await this.options.store.get(`name:${hostname}`);
    return value === undefined ? undefined : stored(entrySchema, value);
  }

  private async countNames(delta: number): Promise<void> {
    const count = z
      .number()
      .int()
      .nonnegative()
      .catch(0)
      .parse(await this.options.store.get(NAME_COUNT));
    if (delta > 0 && count >= this.limits.maxNames) throw new BrokerError(507, "registry-full");
    await this.options.store.put(NAME_COUNT, count + delta);
  }

  private async perform(request: BrokerRequest): Promise<unknown> {
    const { hostname, operation } = request;
    const entry = await this.entry(hostname);
    const mine =
      entry !== undefined &&
      entry.ownerPublicKey === request.ownerPublicKey &&
      entry.gatewayId === request.gatewayId;
    if (operation.type === "claim") {
      // First use binds the name. Whoever claims it later, with another key, is refused.
      if (entry && !mine) throw new BrokerError(409, "name-taken");
      if (!entry) {
        await this.countNames(1);
        await this.options.store.put(`name:${hostname}`, {
          gatewayId: request.gatewayId,
          ownerPublicKey: request.ownerPublicKey,
          claimedAt: Math.floor(this.now() / 1000),
          source: "claim",
        } satisfies Entry);
      } else if (entry.released) {
        const { released: _released, ...rest } = entry;
        await this.options.store.put(`name:${hostname}`, rest);
      }
      return { claimed: true };
    }
    if (!entry) throw new BrokerError(404, "name-not-claimed");
    if (!mine) throw new BrokerError(403, "name-owned-by-another-key");
    const signal = AbortSignal.timeout(15_000);
    switch (operation.type) {
      case "txt-create": {
        if (entry.released) throw new BrokerError(409, "name-released");
        const leases = await this.liveLeases(signal);
        if (
          leases.some((lease) => lease.hostname === hostname) ||
          leases.length >= this.limits.maxLeases
        )
          throw new BrokerError(429, "lease-capacity");
        const lease: TxtLease = {
          id: crypto.randomUUID(),
          hostname,
          value: operation.value,
          expiresAt: this.now() + this.limits.leaseTtlMs,
        };
        // The intent is durable before the record exists, so a crash can't leave it behind.
        await this.options.store.put(`lease:${lease.id}`, lease);
        try {
          await this.options.zone.createTxt(lease, signal);
        } catch {
          await this.removeLease(lease, AbortSignal.timeout(15_000)).catch(() => {});
          throw new BrokerError(502, "dns-publication-failed");
        }
        return { id: lease.id, expiresAt: lease.expiresAt };
      }
      case "txt-remove": {
        const value = await this.options.store.get(`lease:${operation.leaseId}`);
        if (value !== undefined) {
          const lease = stored(leaseSchema, value);
          if (lease.hostname !== hostname) throw new BrokerError(403, "lease-of-another-name");
          await this.removeLease(lease, signal).catch(() => {
            throw new BrokerError(502, "dns-removal-failed");
          });
        }
        return { removed: true };
      }
      case "caa": {
        if (entry.released) throw new BrokerError(409, "name-released");
        if (
          !operation.accountUri.startsWith(this.accountUriPrefix) ||
          operation.accountUri.length === this.accountUriPrefix.length
        )
          throw new BrokerError(400, "account-not-accepted");
        try {
          await this.options.zone.publishName(
            hostname,
            accountBoundCaaValue(this.issuer, operation.accountUri),
            signal,
          );
        } catch {
          throw new BrokerError(502, "dns-publication-failed");
        }
        await this.options.store.put(`name:${hostname}`, {
          ...entry,
          accountUri: operation.accountUri,
        } satisfies Entry);
        return { caa: true };
      }
      case "release": {
        try {
          for (const lease of await this.leases())
            if (lease.hostname === hostname) await this.removeLease(lease, signal);
          await this.options.zone.removeName(hostname, signal);
        } catch {
          throw new BrokerError(502, "dns-removal-failed");
        }
        const { accountUri: _accountUri, ...rest } = entry;
        await this.options.store.put(`name:${hostname}`, { ...rest, released: true });
        return { released: true };
      }
    }
  }

  private async leases(): Promise<TxtLease[]> {
    return [...(await this.options.store.list("lease:")).values()].map((value) =>
      stored(leaseSchema, value),
    );
  }

  /** Scheduling reads metadata only; HTTP traffic never triggers provider cleanup retries. */
  async nextLeaseDeadline(): Promise<number | undefined> {
    const leases = await this.leases();
    return leases.length ? Math.min(...leases.map((lease) => lease.expiresAt)) : undefined;
  }

  /** Reconcile the alarm under the same short lock that protects journal mutations. */
  updateMaintenance(schedule: (next: number | undefined) => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      let next: number | undefined;
      if (this.publicAdmission) {
        next = await this.publicAdmission.budget.expire();
        const used = await this.publicAdmission.expireUsed();
        if (used !== undefined) next = Math.min(next ?? used, used);
      }
      const lease = await this.nextLeaseDeadline();
      if (lease !== undefined) {
        const deadline = lease > this.now() ? lease : this.now() + 60_000;
        next = Math.min(next ?? deadline, deadline);
      }
      await schedule(next);
    });
  }

  /** Leases still running; expired ones are removed first, or kept for a retry if that fails. */
  private async liveLeases(signal: AbortSignal): Promise<TxtLease[]> {
    const live: TxtLease[] = [];
    for (const lease of await this.leases())
      if (lease.expiresAt > this.now()) live.push(lease);
      else await this.removeLease(lease, signal).catch(() => live.push(lease));
    return live;
  }

  private async removeLease(lease: TxtLease, signal: AbortSignal): Promise<void> {
    await this.options.zone.removeTxt(lease, signal);
    await this.options.store.delete(`lease:${lease.id}`);
  }

  /**
   * Removes expired challenges and leases. Returns when the next lease expires, a minute from now
   * when a removal must be retried, or undefined when nothing is left.
   */
  expire(): Promise<number | undefined> {
    if (this.publicAdmission) return this.expirePublic();
    return this.serialize(async () => {
      const now = this.now();
      for (const [key, value] of await this.options.store.list("challenge:")) {
        const row = pendingSchema.safeParse(value);
        if (!row.success || row.data.challenge.expiresAt <= now)
          await this.options.store.delete(key);
      }
      let next: number | undefined;
      for (const lease of await this.liveLeases(AbortSignal.timeout(15_000))) {
        const at = lease.expiresAt > now ? lease.expiresAt : now + 60_000;
        next = next === undefined ? at : Math.min(next, at);
      }
      return next;
    });
  }

  private async expirePublic(): Promise<number | undefined> {
    await this.publicReady;
    const next = await this.serialize(async () => {
      const budget = await this.publicAdmission!.budget.expire();
      const used = await this.publicAdmission!.expireUsed();
      return budget === undefined ? used : used === undefined ? budget : Math.min(budget, used);
    });
    const leases = await this.publicOperations!.expireLeases();
    return next === undefined ? leases : leases === undefined ? next : Math.min(next, leases);
  }

  private async authorizeImport(header: string | null): Promise<void> {
    const offered = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const [a, b] = await Promise.all([sha256Hex(offered), sha256Hex(this.options.importToken!)]);
    let difference = 0;
    for (let index = 0; index < a.length; index++)
      difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    if (difference !== 0) throw new BrokerError(401, "import-refused");
  }

  /**
   * Seeds names the relay had already granted, from an export taken at a trusted moment. An
   * import never replaces a binding: a name already claimed stays with its owner key.
   */
  private async importRegistry(
    input: unknown,
  ): Promise<{ imported: number; existing: number; conflicts: number; invalid: number }> {
    const { entries } = registryImportSchema.parse(input);
    const derived = await Promise.all(
      entries.map((entry) => this.derived(entry.hostname, entry.gatewayId)),
    );
    return this.serialize(async () => {
      const counts = { imported: 0, existing: 0, conflicts: 0, invalid: 0 };
      for (const [index, entry] of entries.entries()) {
        if (!derived[index]) {
          counts.invalid++;
          continue;
        }
        const current = await this.entry(entry.hostname);
        if (current)
          if (
            current.ownerPublicKey === entry.ownerPublicKey &&
            current.gatewayId === entry.gatewayId
          )
            counts.existing++;
          else counts.conflicts++;
        else {
          await this.countNames(1);
          await this.options.store.put(`name:${entry.hostname}`, {
            gatewayId: entry.gatewayId,
            ownerPublicKey: entry.ownerPublicKey,
            claimedAt: Math.floor(this.now() / 1000),
            source: "import",
          } satisfies Entry);
          counts.imported++;
        }
      }
      return counts;
    });
  }
}
