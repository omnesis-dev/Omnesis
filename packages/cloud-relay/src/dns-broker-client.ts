// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's side of the DNS broker. Which broker serves a gateway is decided by local
 * configuration alone (a compiled URL for the official relay, or the operator's environment),
 * never by anything the relay says.
 */
import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { readBoundedJson, savePrivateJson } from "./google-credentials.js";
import { challengeIsFresh, relayOrigin } from "./network.js";
import { DEFAULT_INSTALLATION_RELAY_URL, OFFICIAL_DNS_BROKER_URL } from "./installation-relay.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import {
  brokerChallengeSchema,
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

export interface DnsBrokerSelection {
  url: string;
  /** Set by the operator: no fallback to the relay when the broker can't be reached. */
  required: boolean;
}

/**
 * The broker for a gateway on this relay. `OMNESIS_ACME_DNS_PROVIDER=broker` names one
 * explicitly; by default (`auto`) the official relay's gateways use the compiled official
 * broker when it is reachable, and every other relay keeps its own DNS cooperation.
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
    return { url: OFFICIAL_DNS_BROKER_URL, required: false };
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
        await response.body?.cancel();
        if (response.status === 409 && operation.type === "claim") throw new DnsBrokerNameTaken();
        throw new Error("The DNS broker refused the gateway operation");
      }
      return readBoundedJson(response);
    };
    const challenge = brokerChallengeSchema.parse(await post("/_dns/v2/challenge", request));
    if (
      challenge.brokerOrigin !== broker.origin ||
      challenge.requestDigest !== (await brokerRequestDigest(request)) ||
      !challengeIsFresh(challenge.expiresAt)
    )
      throw new Error("The DNS broker challenge does not match this operation");
    return brokerResultSchemas[operation.type].parse(
      await post("/_dns/v2/complete", {
        challengeId: challenge.challengeId,
        ownerSignature: sign(null, brokerTranscript(challenge), owner).toString("base64url"),
      }),
    );
  };
  return {
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
      await call({ type: "claim" }, signal);
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
}

/**
 * DNS-01 cooperation through the broker when it serves this gateway, else through the relay as
 * before the broker existed. Once the gateway has used the broker it never goes back: a broker
 * that can't be reached then fails the renewal instead of handing challenges to the relay.
 */
export function brokerOrRelayPresenter(options: {
  broker: DnsBrokerClient;
  required: boolean;
  relay?: AcmeDnsPresenter;
  markerFile: string;
}): AcmeDnsPresenter & { brokered(signal: AbortSignal): Promise<boolean> } {
  const routes = new Map<string, AcmeDnsPresenter>();
  const viaBroker = options.broker.presenter();
  const brokered = async (signal: AbortSignal): Promise<boolean> => {
    const sticky = existsSync(options.markerFile);
    if (!(await options.broker.health(signal))) {
      if (options.required || sticky || !options.relay)
        throw new Error("The DNS broker is unavailable");
      return false;
    }
    await options.broker.claim(signal);
    if (!sticky) await savePrivateJson(options.markerFile, { claimedAt: Date.now() });
    return true;
  };
  return {
    brokered,
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
