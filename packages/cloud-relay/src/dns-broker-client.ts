// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's side of the DNS broker. Which broker serves a gateway is decided by local
 * configuration alone (a compiled URL for the official relay, or the operator's environment),
 * never by anything the relay says.
 */
import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { readBoundedJson, readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { caaBinding, lookupCaa, type CaaLookup } from "./acme-caa.js";
import { challengeIsFresh, relayOrigin } from "./network.js";
import { DEFAULT_INSTALLATION_RELAY_URL, OFFICIAL_DNS_BROKER_URL } from "./installation-relay.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import {
  brokerChallengeSchema,
  brokerChallengeAdmissionTranscript,
  brokerHealthSchema,
  brokerRequestDigest,
  brokerResultSchemas,
  brokerTranscript,
  type BrokerHealth,
  type BrokerOperation,
} from "./dns-broker-contract.js";
import type { AcmeDnsPresenter } from "./acme-client.js";

/** The broker binds this gateway's name to another owner key. */
export class DnsBrokerNameTaken extends Error {
  constructor() {
    super("The DNS broker binds this gateway's name to another owner key");
  }
}

export interface DnsBrokerVerification {
  url: string;
  expiresAt: number;
}

/** First setup needs a browser check at the independently configured DNS broker. */
export class DnsBrokerVerificationRequired extends Error {
  constructor(readonly verification: DnsBrokerVerification) {
    super("Open the DNS verification link, then retry this gateway's setup");
  }
}

/** The broker refuses new allocation without affecting already registered gateways. */
export class DnsBrokerAdmissionRefused extends Error {
  constructor(readonly code: "dns-capacity" | "dns-allocation-rate") {
    super(
      code === "dns-capacity"
        ? "Cloud gateway address capacity is full; retry later"
        : "New gateway setup is temporarily rate limited; retry later",
    );
  }
}

export interface DnsBrokerSelection {
  url: string;
  /** A selected broker must authorize the hosted name; no fallback to the relay. */
  required: true;
}

/**
 * The broker for a gateway on this relay. `OMNESIS_ACME_DNS_PROVIDER=broker` names one
 * explicitly; by default (`auto`) the official relay requires the compiled official broker.
 * Every other relay keeps its own DNS cooperation.
 */
export function dnsBrokerSelection(
  env: NodeJS.ProcessEnv,
  relayUrl: string,
): DnsBrokerSelection | undefined {
  const provider = env.OMNESIS_ACME_DNS_PROVIDER ?? "auto";
  if (provider === "broker") {
    if (!env.OMNESIS_ACME_DNS_BROKER_URL)
      throw new Error("The broker DNS provider requires a broker URL");
    return { url: relayOrigin(env.OMNESIS_ACME_DNS_BROKER_URL).origin, required: true };
  }
  if (provider === "auto" && relayOrigin(relayUrl).origin === DEFAULT_INSTALLATION_RELAY_URL)
    return { url: OFFICIAL_DNS_BROKER_URL, required: true };
  return undefined;
}

export interface DnsBrokerClient {
  hostname: string;
  /** The broker's description, or undefined when it is unreachable or serves another domain. */
  health(signal: AbortSignal): Promise<BrokerHealth | undefined>;
  /** Binds the name to this gateway's owner key; a no-op once bound. */
  claim(signal: AbortSignal): Promise<void>;
  presenter(): AcmeDnsPresenter;
  publishCaa(accountUri: string, signal: AbortSignal): Promise<void>;
  release(signal: AbortSignal): Promise<void>;
}

export function dnsBrokerClient(options: {
  brokerUrl: string;
  relayUrl: string;
  gatewayId: string;
  owner: () => Promise<KeyObject>;
  fetch?: typeof fetch;
  /** Called only for a verified URL on the locally configured broker origin. */
  onVerificationRequired?(verification: DnsBrokerVerification | undefined): void;
  /** Test seam: production waits two seconds before retrying browser verification. */
  verificationPollMs?: number;
}): DnsBrokerClient {
  const broker = relayOrigin(options.brokerUrl);
  const relayDomain = relayOrigin(options.relayUrl).hostname;
  const gatewayId = options.gatewayId.toLowerCase();
  const hostname = hostedGatewayHostname(gatewayId, relayDomain);
  const transport = options.fetch ?? fetch;
  let known: { value: BrokerHealth; until: number } | undefined;
  const call = async (operation: BrokerOperation, caller: AbortSignal): Promise<unknown> => {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(15_000)]);
    const owner = await options.owner();
    const request = {
      hostname,
      gatewayId,
      ownerPublicKey: createPublicKey(owner)
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      operation,
    };
    const post = async (path: string, body: unknown): Promise<unknown> => {
      signal.throwIfAborted();
      const response = await transport(new URL(path, broker), {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 428 && operation.type === "claim") {
          const body = z
            .object({
              error: z.literal("browser-verification-required"),
              verification: z
                .object({ url: z.string().max(16_384), expiresAt: z.number().int().positive() })
                .strict(),
            })
            .strict()
            .parse(await readBoundedJson(response));
          const url = new URL(body.verification.url);
          if (
            url.origin !== broker.origin ||
            url.username ||
            url.password ||
            url.pathname !== "/_dns/v2/enroll" ||
            url.hash ||
            [...url.searchParams.keys()].some((key) => key !== "ticket") ||
            url.searchParams.getAll("ticket").length !== 1 ||
            !url.searchParams.get("ticket") ||
            body.verification.expiresAt <= Date.now() ||
            body.verification.expiresAt > Date.now() + 11 * 60_000
          ) {
            throw new Error("The DNS broker verification destination was refused");
          }
          throw new DnsBrokerVerificationRequired(body.verification);
        }
        if (response.status === 429 || response.status === 507) {
          const value = await readBoundedJson(response).catch(() => undefined);
          const refused = z
            .object({ error: z.enum(["dns-capacity", "dns-allocation-rate"]) })
            .safeParse(value);
          if (refused.success) throw new DnsBrokerAdmissionRefused(refused.data.error);
          throw new Error("The DNS broker refused the gateway operation");
        }
        await response.body?.cancel();
        if (response.status === 409 && operation.type === "claim") throw new DnsBrokerNameTaken();
        throw new Error("The DNS broker refused the gateway operation");
      }
      return readBoundedJson(response);
    };
    const requestDigest = await brokerRequestDigest(request);
    const health = await client.health(signal);
    const expiresAt = Date.now() + 30_000;
    const proof = health?.ownerProofRequired
      ? {
          expiresAt,
          signature: sign(
            null,
            brokerChallengeAdmissionTranscript(broker.origin, requestDigest, expiresAt),
            owner,
          ).toString("base64url"),
        }
      : undefined;
    const challenge = brokerChallengeSchema.parse(
      await post("/_dns/v2/challenge", { ...request, ...(proof ? { proof } : {}) }),
    );
    if (
      challenge.brokerOrigin !== broker.origin ||
      challenge.requestDigest !== requestDigest ||
      !challengeIsFresh(challenge.expiresAt)
    )
      throw new Error("The DNS broker challenge does not match this operation");
    return brokerResultSchemas[operation.type].parse(
      await post("/_dns/v2/complete", {
        challengeId: challenge.challengeId,
        ...("ticket" in challenge ? { ticket: challenge.ticket } : {}),
        ownerSignature: sign(null, brokerTranscript(challenge), owner).toString("base64url"),
      }),
    );
  };
  const client: DnsBrokerClient = {
    hostname,
    async health(caller) {
      if (known && known.until > Date.now()) return known.value;
      try {
        const response = await transport(new URL("/_dns/v2/health", broker), {
          redirect: "error",
          signal: AbortSignal.any([caller, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return undefined;
        }
        const value = brokerHealthSchema.parse(await readBoundedJson(response));
        if (value.relayDomain !== relayDomain) return undefined;
        known = { value, until: Date.now() + 600_000 };
        return value;
      } catch {
        caller.throwIfAborted();
        return undefined;
      }
    },
    async claim(signal) {
      let verification: DnsBrokerVerification | undefined;
      try {
        for (;;) {
          signal.throwIfAborted();
          try {
            await call({ type: "claim" }, signal);
            return;
          } catch (error) {
            if (
              !(error instanceof DnsBrokerVerificationRequired) ||
              !options.onVerificationRequired
            )
              throw error;
            if (!verification) {
              verification = error.verification;
              options.onVerificationRequired(verification);
            }
            if (verification.expiresAt <= Date.now())
              throw new Error("DNS browser verification expired", { cause: error });
            await delay(options.verificationPollMs ?? 2000, undefined, { signal });
          }
        }
      } finally {
        if (verification) options.onVerificationRequired?.(undefined);
      }
    },
    presenter: () => ({
      async create(value, signal) {
        return (await call({ type: "txt-create", value }, signal)) as { id: string };
      },
      async remove(id) {
        // Cleanup has its own bounded lifetime even after issuance was cancelled.
        await call({ type: "txt-remove", leaseId: id }, AbortSignal.timeout(15_000));
      },
    }),
    async publishCaa(accountUri, signal) {
      await call({ type: "caa", accountUri }, signal);
    },
    async release(signal) {
      await call({ type: "release" }, signal);
    },
  };
  return client;
}

const markerSchema = z
  .object({ claimedAt: z.number().int().nonnegative(), accountUri: z.string().optional() })
  .strict();

/** What the gateway recorded of its use of the broker; undefined before it first used it. */
export async function readBrokerMarker(
  file: string,
): Promise<z.infer<typeof markerSchema> | undefined> {
  try {
    return markerSchema.parse(await readPrivateJson(file));
  } catch (error) {
    if (ownedProcessCleanupReceipt(error) !== undefined) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/**
 * DNS-01 cooperation through the broker when it serves this gateway, else through the relay as
 * before the broker existed. Once the gateway has used the broker it never goes back: a broker
 * that can't be reached then fails the renewal instead of handing challenges to the relay.
 *
 * Before each order, a gateway on the broker has its name's CAA record bind issuance to its own
 * ACME account (for the broker's CA only, so a staging account publishes nothing), and waits
 * a bounded time for DNS to show it.
 */
export function brokerOrRelayPresenter(options: {
  broker: DnsBrokerClient;
  required: boolean;
  relay?: AcmeDnsPresenter;
  markerFile: string;
  caaLookup?: CaaLookup;
  /** Pause between CAA lookups while the record propagates. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}): AcmeDnsPresenter & {
  brokered(signal: AbortSignal): Promise<boolean>;
  beforeOrder(accountUri: string, signal: AbortSignal): Promise<void>;
} {
  const routes = new Map<string, AcmeDnsPresenter>();
  const viaBroker = options.broker.presenter();
  const brokered = async (signal: AbortSignal): Promise<boolean> => {
    const marker = await readBrokerMarker(options.markerFile);
    if (!(await options.broker.health(signal))) {
      if (options.required || marker || !options.relay)
        throw new Error("The DNS broker is unavailable");
      return false;
    }
    await options.broker.claim(signal);
    if (!marker) await savePrivateJson(options.markerFile, { claimedAt: Date.now() });
    return true;
  };
  return {
    brokered,
    async beforeOrder(accountUri, signal) {
      if (!(await brokered(signal))) return;
      const health = (await options.broker.health(signal))!;
      const prefix = health.caa.accountUriPrefix;
      if (!accountUri.startsWith(prefix) || accountUri.length === prefix.length) return;
      const marker = (await readBrokerMarker(options.markerFile))!;
      if (marker.accountUri !== accountUri) {
        await options.broker.publishCaa(accountUri, signal);
        await savePrivateJson(options.markerFile, { ...marker, accountUri });
      }
      const lookup = options.caaLookup ?? lookupCaa;
      for (let count = 0; count < 60; count++) {
        const issue = await lookup(options.broker.hostname, signal);
        if (issue && caaBinding(issue, accountUri) === "bound") return;
        await (options.delay ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(
          1000,
          signal,
        );
      }
      // Still not visible here: the CA reads the authoritative answer, and the order is
      // checked again against what DNS shows before it is placed.
    },
    async create(value, signal) {
      const use = (await brokered(signal)) ? viaBroker : options.relay!;
      const lease = await use.create(value, signal);
      routes.set(lease.id, use);
      return lease;
    },
    async remove(id, signal) {
      const use = routes.get(id) ?? viaBroker;
      routes.delete(id);
      await use.remove(id, signal);
    },
  };
}
