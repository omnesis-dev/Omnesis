// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { hostedGatewayHostname } from "../src/hosted-name.js";
import {
  brokerTranscript,
  type BrokerChallenge,
  type BrokerOperation,
} from "../src/dns-broker-contract.js";
import type { BrokerStore } from "../src/dns-broker-core.js";

/** A gateway's owner identity, as the broker sees it, and a signer for its challenges. */
export function brokerOwner(relayDomain = "relay.example.test", gatewayId: string = randomUUID()) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return ownerFrom(privateKey, publicKey, relayDomain, gatewayId);
}

export function ownerFrom(
  privateKey: KeyObject,
  publicKey: KeyObject,
  relayDomain: string,
  gatewayId: string,
) {
  const ownerPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const hostname = hostedGatewayHostname(gatewayId, relayDomain);
  return {
    privateKey,
    gatewayId,
    hostname,
    ownerPublicKey,
    request: (operation: BrokerOperation) => ({ hostname, gatewayId, ownerPublicKey, operation }),
    sign: (challenge: BrokerChallenge) =>
      sign(null, brokerTranscript(challenge), privateKey).toString("base64url"),
  };
}
export type BrokerOwner = ReturnType<typeof brokerOwner>;

/** Runs one challenge and completion against a fetch handler, as a gateway would. */
export async function brokerCall(
  handle: (request: Request) => Promise<Response>,
  owner: BrokerOwner,
  operation: BrokerOperation,
  origin = "https://dns.example.test",
): Promise<{ status: number; body: unknown }> {
  const post = (path: string, body: unknown) =>
    handle(
      new Request(new URL(path, origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const first = await post("/_dns/v2/challenge", owner.request(operation));
  if (!first.ok) return { status: first.status, body: await first.json() };
  const challenge = (await first.json()) as BrokerChallenge;
  const second = await post("/_dns/v2/complete", {
    challengeId: challenge.challengeId,
    ownerSignature: owner.sign(challenge),
  });
  return { status: second.status, body: await second.json() };
}

/** The broker's store in memory, as a Durable Object's storage behaves. */
export function memoryStore(): BrokerStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    delete: async (key) => void values.delete(key),
    list: async (prefix) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, v])),
  };
}
