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
import {
  DNS_BROKER_PROTOCOL,
  accountBoundCaaValue,
  accountUriSchema,
  brokerChallengeSchema,
  brokerCompletionSchema,
  brokerRequestDigest,
  brokerRequestSchema,
  hostedLabel,
  ownerPublicKeySchema,
  registryImportSchema,
  relayDomainSchema,
  sha256Hex,
  verifyOwnerSignature,
  type BrokerChallenge,
  type BrokerHealth,
  type BrokerRequest,
} from "./dns-broker-contract.js";
import type { BrokerZone, TxtLease } from "./dns-broker-zone.js";

/** Durable key-value storage; a Durable Object's storage and a private file both fit. */
export interface BrokerStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Map<string, unknown>>;
}

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
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
}

const entrySchema = z
  .object({
    gatewayId: z.string().uuid(),
    ownerPublicKey: ownerPublicKeySchema,
    claimedAt: z.number().int().nonnegative(),
    source: z.enum(["claim", "import"]),
    released: z.boolean().optional(),
    accountUri: accountUriSchema.optional(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
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
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function brokerOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The DNS broker origin must be an HTTPS origin");
  return url.origin;
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new BrokerError(415, "json-required");
  const reader = request.body?.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const part = await reader?.read();
    if (!part || part.done) break;
    size += part.value.length;
    if (size > limit) {
      await reader!.cancel();
      throw new BrokerError(413, "request-too-large");
    }
    text += decoder.decode(part.value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new BrokerError(400, "invalid-json");
  }
}

export class DnsBroker {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly origin: string;
  private readonly relayDomain: string;
  private readonly issuer: string;
  private readonly accountUriPrefix: string;
  private readonly now: () => number;
  private readonly limits: {
    leaseTtlMs: number;
    challengeTtlMs: number;
    maxChallenges: number;
    maxLeases: number;
    maxNames: number;
  };
  constructor(private readonly options: DnsBrokerOptions) {
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
  }

  health(): BrokerHealth {
    return {
      protocol: DNS_BROKER_PROTOCOL,
      relayDomain: this.relayDomain,
      caa: { issuer: this.issuer, accountUriPrefix: this.accountUriPrefix },
    };
  }

  /** Every route, as a fetch handler. Errors carry a fixed code and never echo input. */
  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      let result: unknown;
      if (path === "/_dns/v2/health") {
        if (request.method !== "GET") throw new BrokerError(405, "method-not-allowed");
        result = this.health();
      } else if (
        ["/_dns/v2/challenge", "/_dns/v2/complete"].includes(path) ||
        (path === "/_dns/v2/import" && this.options.importToken !== undefined)
      ) {
        if (request.method !== "POST") throw new BrokerError(405, "method-not-allowed");
        if (path === "/_dns/v2/import") {
          await this.authorizeImport(request.headers.get("authorization"));
          result = await this.importRegistry(await readJson(request, 1_048_576));
        } else {
          const body = await readJson(request, 16_384);
          result =
            path === "/_dns/v2/challenge" ? await this.challenge(body) : await this.complete(body);
        }
      } else throw new BrokerError(404, "not-found");
      return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
    } catch (error) {
      const known =
        error instanceof BrokerError
          ? error
          : error instanceof z.ZodError
            ? new BrokerError(400, "invalid-request")
            : new BrokerError(500, "broker-failure");
      return new Response(JSON.stringify({ error: known.code }), {
        status: known.status,
        headers: JSON_HEADERS,
      });
    }
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async derived(hostname: string, gatewayId: string): Promise<boolean> {
    return hostname === `${await hostedLabel(gatewayId)}.${this.relayDomain}`;
  }

  async challenge(input: unknown): Promise<BrokerChallenge> {
    const request = brokerRequestSchema.parse(input);
    // Only a gateway's own derived name under the relay domain is ever brokered.
    if (!(await this.derived(request.hostname, request.gatewayId)))
      throw new BrokerError(403, "name-not-derived");
    const requestDigest = await brokerRequestDigest(request);
    return this.serialize(async () => {
      const now = this.now();
      let pending = 0;
      for (const [key, value] of await this.options.store.list("challenge:")) {
        const row = pendingSchema.safeParse(value);
        if (!row.success || row.data.challenge.expiresAt <= now)
          await this.options.store.delete(key);
        else pending++;
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
    const value = brokerCompletionSchema.parse(input);
    return this.serialize(async () => {
      const key = `challenge:${value.challengeId}`;
      const row = pendingSchema.safeParse(await this.options.store.get(key));
      if (!row.success) throw new BrokerError(401, "challenge-unknown");
      // One use, whatever the outcome.
      await this.options.store.delete(key);
      const { request, challenge } = row.data;
      if (challenge.expiresAt <= this.now()) throw new BrokerError(401, "challenge-unknown");
      if (!(await verifyOwnerSignature(request.ownerPublicKey, challenge, value.ownerSignature)))
        throw new BrokerError(401, "signature-refused");
      return this.perform(request);
    });
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
